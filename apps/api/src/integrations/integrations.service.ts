import { SealKeys, sealIntegration } from "@realentity/storm-crypto";
import { Integrations, Prisma } from "@realentity/storm-db";
import { fixedServers, llmOver, OPENAI_PREFIX, OpenAiApi, serverModelId } from "@realentity/storm-llm";
import {
  CLAUDE_MODELS,
  type IntegrationTestView,
  type IntegrationUpdate,
  type IntegrationView,
  IntegrationCreateSchema,
} from "@realentity/storm-shared";
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";

type Row = Prisma.IntegrationGetPayload<object> & { kind: "CLAUDE" | "OPENAI_COMPATIBLE" };

/** M63: this card's rows only; Telegram and Google have their own pages. */
const AI_KINDS = { kind: { in: ["CLAUDE" as const, "OPENAI_COMPATIBLE" as const] } };

const view = (row: Row): IntegrationView => ({
  integrationId: row.integrationId,
  kind: row.kind,
  name: row.name,
  enabled: row.enabled,
  baseUrl: (row.config as { baseUrl?: string } | null)?.baseUrl ?? null,
  secretHint: row.secretHint,
  dateUpdated: row.dateUpdated.toISOString(),
});

/** The last four characters, to recognise a key by; nothing of a short one. */
export const hintOf = (secret: string): string | null => (secret.length >= 12 ? `…${secret.slice(-4)}` : null);

/**
 * M62: Claude and the model servers (Settings → AI, docs/design.md §5, §7). Secrets are sealed with the integration key
 * and never returned; a change of an address or a key needs the authenticator code again (M62-T6), as it decides where
 * your email text goes.
 */
@Injectable()
export class IntegrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: SealKeys,
    private readonly integrations: Integrations,
    private readonly auth: AuthService,
  ) {}

  async list(userId: string): Promise<IntegrationView[]> {
    const rows = await this.prisma.client.integration.findMany({ where: { userId, ...AI_KINDS }, orderBy: [{ kind: "asc" }, { dateCreated: "asc" }] });
    return (rows as Row[]).map(view);
  }

  async create(userId: string, body: z.output<typeof IntegrationCreateSchema>): Promise<IntegrationView> {
    this.auth.checkCode(body.code);
    if (body.kind === "CLAUDE" && (await this.prisma.client.integration.count({ where: { userId, kind: "CLAUDE" } })) > 0) {
      throw new ConflictException("Claude is set up already: replace its key there");
    }
    const integrationId = randomUUID();
    const secret = body.secret ?? null;
    try {
      const row = await this.prisma.client.integration.create({
        data: {
          integrationId,
          userId,
          kind: body.kind,
          name: body.name,
          config: body.kind === "OPENAI_COMPATIBLE" ? { baseUrl: body.baseUrl } : {},
          ...(secret ? { ...sealIntegration(this.keys, integrationId, secret), secretHint: hintOf(secret) } : {}),
        },
      });
      return view(row as Row);
    } catch (error) {
      throw this.nameTaken(error, body.name);
    } finally {
      this.integrations.forget(userId);
    }
  }

  async update(userId: string, integrationId: string, body: IntegrationUpdate): Promise<IntegrationView> {
    const row = await this.find(userId, integrationId);
    if (body.baseUrl !== undefined || body.secret !== undefined) this.auth.checkCode(body.code);
    if (body.baseUrl !== undefined && row.kind === "CLAUDE") throw new BadRequestException("Claude has no address to set");
    if (body.secret === null && row.kind === "CLAUDE") throw new BadRequestException("Claude needs its key: remove Claude instead");
    const sealed =
      body.secret === undefined
        ? {}
        : body.secret === null
          ? { ciphertext: null, iv: null, authTag: null, wrappedDek: null, keyVersion: null, secretHint: null }
          : { ...sealIntegration(this.keys, integrationId, body.secret), secretHint: hintOf(body.secret) };
    try {
      const updated = await this.prisma.client.integration.update({
        where: { integrationId },
        data: {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.baseUrl !== undefined ? { config: { baseUrl: body.baseUrl } } : {}),
          ...sealed,
        },
      });
      return view(updated as Row);
    } catch (error) {
      throw this.nameTaken(error, body.name ?? row.name);
    } finally {
      this.integrations.forget(userId);
    }
  }

  /** Removed with what only it could answer: the tasks' choices of its models, the default model, the embeddings. */
  async remove(userId: string, integrationId: string): Promise<void> {
    await this.find(userId, integrationId);
    const prefix = `${OPENAI_PREFIX}${integrationId}:`;
    await this.prisma.client.$transaction([
      this.prisma.client.modelSetting.deleteMany({ where: { userId, model: { startsWith: prefix } } }),
      this.prisma.client.userSetting.updateMany({ where: { userId, defaultModel: { startsWith: prefix } }, data: { defaultModel: null } }),
      this.prisma.client.userSetting.updateMany({ where: { userId, embeddingsIntegrationId: integrationId }, data: { embeddingsModel: null } }),
      this.prisma.client.integration.delete({ where: { integrationId } }),
    ]);
    this.integrations.forget(userId);
  }

  /** M62-T2: what it offers, and one short answer, timed. On or off, it is tried as it is set up. */
  async test(userId: string, integrationId: string, model?: string): Promise<IntegrationTestView> {
    await this.find(userId, integrationId);
    const open = (await this.integrations.of(userId)).find((i) => i.integrationId === integrationId);
    if (!open) throw new NotFoundException("No such model server");
    let models: string[] = [];
    let asked: string | null = null;
    try {
      if (open.kind === "CLAUDE") {
        models = [...CLAUDE_MODELS];
        asked = model && (CLAUDE_MODELS as readonly string[]).includes(model) ? model : "claude-haiku-5-5";
      } else {
        models = await new OpenAiApi({ baseUrl: open.baseUrl ?? "", apiKey: open.secret ?? undefined }).models();
        asked = model ?? null;
        if (asked && !models.includes(asked)) throw new BadRequestException(`${asked} isn't on this server`);
      }
      if (!asked) return { ok: true, models, model: null, seconds: null, error: null };
      const llm = llmOver(fixedServers({ anthropicApiKey: open.kind === "CLAUDE" ? (open.secret ?? undefined) : undefined, openaiBaseUrl: open.baseUrl ?? undefined, openaiApiKey: open.secret ?? undefined }));
      const started = performance.now();
      const answer = await llm.client.structured({
        choice: { model: open.kind === "CLAUDE" ? asked : serverModelId(integrationId, asked), effort: "low" },
        system: "You answer tests of a connection. Reply as asked.",
        prompt: 'Reply with {"ok": true}.',
        schema: z.object({ ok: z.boolean() }),
        maxTokens: 2000,
      });
      const seconds = Math.round((performance.now() - started) / 100) / 10;
      return { ok: answer.output.ok, models, model: asked, seconds, error: answer.output.ok ? null : "It answered, but not as asked" };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      return { ok: false, models, model: asked, seconds: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async find(userId: string, integrationId: string): Promise<Row> {
    const row = await this.prisma.client.integration.findFirst({ where: { integrationId, userId, ...AI_KINDS } });
    if (!row) throw new NotFoundException("No such model server");
    return row as Row;
  }

  private nameTaken(error: unknown, name: string): unknown {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" ? new ConflictException(`"${name}" is taken: choose another name`) : error;
  }
}


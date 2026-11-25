import { type KeyRing, openIntegration } from "@realentity/storm-crypto";
import { type PrismaClient } from "./generated/prisma/client";

/** An Integration as the clients need it: its secret opened. Never leaves the process. */
export interface OpenIntegration {
  integrationId: string;
  kind: "CLAUDE" | "OPENAI_COMPATIBLE";
  name: string;
  enabled: boolean;
  baseUrl: string | null;
  secret: string | null;
}

const OPENAI_PREFIX = "openai:";
const SERVER_ID = /^openai:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/i;

/**
 * M62: the user's connections (Integration, Settings → AI) for the api's and the worker's clients: the Claude key, the
 * model servers, the default model and which models can be used now, the embeddings server. Read from the database and
 * kept for a few seconds; `forget()` after a change (the api), else a change reaches the other process within `ttlMs`.
 * Its shapes match @realentity/storm-llm's ModelServers and ModelPrefs.
 */
export class Integrations {
  private readonly cache = new Map<string, { at: number; rows: Promise<OpenIntegration[]> }>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly keys: KeyRing,
    private readonly ttlMs = 10_000,
  ) {}

  /** The user's integrations, secrets opened. */
  of(userId: string): Promise<OpenIntegration[]> {
    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.at < this.ttlMs) return cached.rows;
    const rows = this.load(userId);
    this.cache.set(userId, { at: Date.now(), rows });
    rows.catch(() => this.cache.delete(userId));
    return rows;
  }

  forget(userId?: string): void {
    if (userId) this.cache.delete(userId);
    else this.cache.clear();
  }

  private async load(userId: string): Promise<OpenIntegration[]> {
    const rows = await this.prisma.integration.findMany({ where: { userId }, orderBy: { dateCreated: "asc" } });
    return rows.map((row) => ({
      integrationId: row.integrationId,
      kind: row.kind,
      name: row.name,
      enabled: row.enabled,
      baseUrl: (row.config as { baseUrl?: string } | null)?.baseUrl ?? null,
      secret:
        row.ciphertext && row.iv && row.authTag && row.wrappedDek && row.keyVersion !== null
          ? openIntegration(this.keys, row.integrationId, {
              ciphertext: row.ciphertext,
              iv: row.iv,
              authTag: row.authTag,
              wrappedDek: row.wrappedDek,
              keyVersion: row.keyVersion,
            })
          : null,
    }));
  }

  /** Storm is single-user: without an owner (a job across users), the one user's settings. */
  private async ownerOf(owner: string | undefined): Promise<string | null> {
    if (owner) return owner;
    return (await this.prisma.user.findFirst({ select: { userId: true }, orderBy: { dateCreated: "asc" } }))?.userId ?? null;
  }

  // ModelServers

  async claude(owner: string | undefined): Promise<string | null> {
    const userId = await this.ownerOf(owner);
    if (!userId) return null;
    return (await this.of(userId)).find((i) => i.kind === "CLAUDE" && i.enabled && i.secret)?.secret ?? null;
  }

  async server(serverId: string | null, owner: string | undefined): Promise<{ baseUrl: string; apiKey?: string } | null> {
    const userId = await this.ownerOf(owner);
    if (!userId || !serverId) return null;
    const server = (await this.of(userId)).find((i) => i.integrationId === serverId && i.kind === "OPENAI_COMPATIBLE" && i.enabled && i.baseUrl);
    return server?.baseUrl ? { baseUrl: server.baseUrl, ...(server.secret ? { apiKey: server.secret } : {}) } : null;
  }

  // ModelPrefs

  async prefs(userId: string): Promise<{ defaultModel: string | null; usable(model: string): boolean }> {
    const [rows, setting] = await Promise.all([
      this.of(userId),
      this.prisma.userSetting.findUnique({ where: { userId }, select: { defaultModel: true } }),
    ]);
    return { defaultModel: setting?.defaultModel ?? null, usable: (model) => usable(rows, model) };
  }

  /** Some model can answer: the LLM steps, the builder and reflection have something to use. */
  async configured(userId: string): Promise<boolean> {
    return (await this.of(userId)).some((i) => i.enabled && (i.kind === "CLAUDE" ? Boolean(i.secret) : Boolean(i.baseUrl)));
  }

  /** The embeddings server and model chosen in Settings → AI, if it is there and on. */
  async embeddings(owner?: string): Promise<{ baseUrl: string; apiKey?: string; model: string } | null> {
    const userId = await this.ownerOf(owner);
    if (!userId) return null;
    const setting = await this.prisma.userSetting.findUnique({ where: { userId }, select: { embeddingsIntegrationId: true, embeddingsModel: true } });
    if (!setting?.embeddingsIntegrationId || !setting.embeddingsModel) return null;
    const server = await this.server(setting.embeddingsIntegrationId, userId);
    return server ? { ...server, model: setting.embeddingsModel } : null;
  }
}

/** Claude's models while Claude is set up and on; a server's while it is there and on. */
export function usable(rows: OpenIntegration[], model: string): boolean {
  if (!model.startsWith(OPENAI_PREFIX)) return rows.some((i) => i.kind === "CLAUDE" && i.enabled && Boolean(i.secret));
  const id = SERVER_ID.exec(model)?.[1]?.toLowerCase();
  return Boolean(id) && rows.some((i) => i.integrationId === id && i.kind === "OPENAI_COMPATIBLE" && i.enabled);
}

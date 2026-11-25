import { type KeyRing, openIntegration } from "@realentity/storm-crypto";
import { type PrismaClient } from "./generated/prisma/client";

/** An Integration as the clients need it: its secret opened. Never leaves the process. */
export interface OpenIntegration {
  integrationId: string;
  kind: "CLAUDE" | "OPENAI_COMPATIBLE" | "TELEGRAM" | "GOOGLE_OAUTH";
  name: string;
  enabled: boolean;
  baseUrl: string | null;
  /** Nothing secret: { chatId, webhookUrl } for TELEGRAM, { clientId } for GOOGLE_OAUTH. */
  config: Record<string, unknown>;
  secret: string | null;
  /** M63: the Telegram webhook secret's SHA-256 (hex), compared and never opened. */
  secretHash: string | null;
}

/** M63: the run limits in effect (Settings → Runs & browser), their defaults while none is set. */
export interface RunLimits {
  artifactsRetentionDays: number;
  takeoverTimeoutMinutes: number;
  downloadMaxMb: number;
}

/** The same as @realentity/storm-shared's RUN_LIMIT_DEFAULTS (db doesn't depend on shared). */
export const RUN_LIMIT_DEFAULTS: RunLimits = { artifactsRetentionDays: 90, takeoverTimeoutMinutes: 30, downloadMaxMb: 25 };

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
      config: (row.config ?? {}) as Record<string, unknown>,
      secretHash: row.secretHash,
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

  // M63: the Storm bot, Google's OAuth client, the run limits

  /** The Storm bot while it is set up and on; {} otherwise (nothing is sent). Matches shared's TelegramConfig. */
  async telegram(owner?: string): Promise<{ botToken?: string; chatId?: string }> {
    const userId = await this.ownerOf(owner);
    if (!userId) return {};
    const bot = (await this.of(userId)).find((i) => i.kind === "TELEGRAM");
    const chatId = typeof bot?.config.chatId === "string" ? bot.config.chatId : undefined;
    return bot?.enabled && bot.secret && chatId ? { botToken: bot.secret, chatId } : {};
  }

  /** The webhook secret's hash, while the bot is on: /hooks/telegram takes only updates that carry it. */
  async telegramWebhookHash(owner?: string): Promise<string | null> {
    const userId = await this.ownerOf(owner);
    if (!userId) return null;
    const bot = (await this.of(userId)).find((i) => i.kind === "TELEGRAM");
    return bot?.enabled ? bot.secretHash : null;
  }

  /** Google's OAuth client, when both halves are saved. */
  async google(owner?: string): Promise<{ clientId: string; clientSecret: string } | null> {
    const userId = await this.ownerOf(owner);
    if (!userId) return null;
    const client = (await this.of(userId)).find((i) => i.kind === "GOOGLE_OAUTH");
    const clientId = typeof client?.config.clientId === "string" ? client.config.clientId : null;
    return client?.enabled && client.secret && clientId ? { clientId, clientSecret: client.secret } : null;
  }

  /** The run limits in effect: read each time (a cheap row), so a change applies to the next step. */
  async runLimits(owner?: string): Promise<RunLimits> {
    const userId = await this.ownerOf(owner);
    const setting = userId
      ? await this.prisma.userSetting.findUnique({
          where: { userId },
          select: { artifactsRetentionDays: true, takeoverTimeoutMinutes: true, downloadMaxMb: true },
        })
      : null;
    return {
      artifactsRetentionDays: setting?.artifactsRetentionDays ?? RUN_LIMIT_DEFAULTS.artifactsRetentionDays,
      takeoverTimeoutMinutes: setting?.takeoverTimeoutMinutes ?? RUN_LIMIT_DEFAULTS.takeoverTimeoutMinutes,
      downloadMaxMb: setting?.downloadMaxMb ?? RUN_LIMIT_DEFAULTS.downloadMaxMb,
    };
  }

  /** The webhooks' public address (Settings → Telegram); null: not set. */
  async hooksPublicUrl(owner?: string): Promise<string | null> {
    const userId = await this.ownerOf(owner);
    if (!userId) return null;
    return (await this.prisma.userSetting.findUnique({ where: { userId }, select: { hooksPublicUrl: true } }))?.hooksPublicUrl ?? null;
  }
}

/** Claude's models while Claude is set up and on; a server's while it is there and on. */
export function usable(rows: OpenIntegration[], model: string): boolean {
  if (!model.startsWith(OPENAI_PREFIX)) return rows.some((i) => i.kind === "CLAUDE" && i.enabled && Boolean(i.secret));
  const id = SERVER_ID.exec(model)?.[1]?.toLowerCase();
  return Boolean(id) && rows.some((i) => i.integrationId === id && i.kind === "OPENAI_COMPATIBLE" && i.enabled);
}

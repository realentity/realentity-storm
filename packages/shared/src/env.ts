import { z } from "zod";
import { isTimeZone } from "./time-zone";

/** Empty values in .env (KEY=) count as not set. */
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

/** 32 bytes: 64 hex characters, or base64 (43 characters plus one "="). Checked without Buffer so the schema also builds for the browser. */
const KEY_32_BYTES = /^(?:[0-9a-fA-F]{64}|[A-Za-z0-9+/]{43}=)$/;

/** Environment of the api and the worker (one .env in the repository root). Later milestones add their keys here. */
export const ServerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** The server's time zone (Node follows TZ): the default for schedules, the morning brief and the weekly review. */
  TZ: optional(z.string().refine(isTimeZone, "an IANA time zone, e.g. Europe/London")),

  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgresql:// connection string"),

  ENCRYPTION_KEY: z.string().trim().regex(KEY_32_BYTES, "must be 32 bytes: openssl rand -hex 32 or openssl rand -base64 32"),
  ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),

  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  APP_ADMIN_EMAIL: z.string().min(3).default("me@localhost"),
  /** argon2id hash; login is refused until it is set (pnpm auth:setup). */
  APP_ADMIN_PASSWORD_HASH: optional(z.string().startsWith("$argon2id$", "must be an argon2id hash (pnpm auth:setup)")),
  /** Base32 TOTP secret; login is refused until it is set (pnpm auth:setup). */
  APP_TOTP_SECRET: optional(z.string().regex(/^[A-Z2-7]{16,}=*$/, "must be a base32 TOTP secret (pnpm auth:setup)")),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),
  /**
   * The address the browser uses (e.g. behind a reverse proxy: https://storm.example.com). The live events
   * socket then accepts only this Origin; unset, the Origin must match the Host header (development).
   */
  APP_ORIGIN: optional(z.url({ protocol: /^https?$/ }).transform((url) => new URL(url).origin)),

  /**
   * Browser (docs/design.md §6). Files the pipelines produce (screenshots, traces, downloads) live here; the worker writes,
   * the api serves them to the user.
   */
  ARTIFACTS_DIR: z.string().min(1).default("data/artifacts"),
  /** The user's documents (CV, cover letters) that forms may attach: the api writes them, the worker only reads. */
  DOCUMENTS_DIR: z.string().min(1).default("data/documents"),
  /** Live view: x11vnc's passwords, full control and view-only (VNC uses the first 8 characters). Unset: no live view. */
  VNC_PASSWORD: optional(z.string().min(8)),
  VNC_VIEW_PASSWORD: optional(z.string().min(8)),

  /** What the server's own jobs send with their reports (POST /hooks/health, M26). */
  HEALTH_REPORT_TOKEN: optional(z.string().regex(/^[A-Za-z0-9_-]{32,256}$/, "32 to 256 of A-Z a-z 0-9 _ -: openssl rand -hex 32")),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

/**
 * Keys no longer read. M62: Claude, the model servers, the embeddings, the models, the budget and the builder's limit
 * are set up in Settings → AI. M63: the Storm bot and the hooks address in Settings → Telegram, Google's OAuth client in
 * Settings → Google, the run limits in Settings → Runs & browser. Storm starts without reading them, and warns that
 * they are still in .env.
 */
export const REMOVED_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "EMBEDDINGS_MODEL",
  "LLM_MODEL",
  "LLM_MODEL_CLASSIFY",
  "LLM_MODEL_WRITING",
  "LLM_MODEL_REFLECTION",
  "LLM_MODEL_BUILDER",
  "LLM_MONTHLY_BUDGET_USD",
  "BUILDER_CHAT_MAX_TOKENS",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "TELEGRAM_WEBHOOK_SECRET",
  "HOOKS_PUBLIC_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "ARTIFACTS_RETENTION_DAYS",
  "TAKEOVER_TIMEOUT_MINUTES",
  "DOWNLOAD_MAX_MB",
] as const;

/** The warning for removed keys still set, or null. */
export function removedEnvWarning(raw: Record<string, string | undefined>): string | null {
  const set = REMOVED_ENV_KEYS.filter((key) => raw[key]);
  return set.length === 0 ? null : `No longer read from .env (set them up in Settings, then remove them): ${set.join(", ")}`;
}

/**
 * Validates the environment. The error lists the invalid keys and why, never their values (they are secrets).
 */
export function parseServerEnv(raw: Record<string, string | undefined>): ServerEnv {
  const result = ServerEnvSchema.safeParse(raw);
  if (result.success) return result.data;
  const problems = result.error.issues.map(
    (issue) => `  ${issue.path.join(".")}: ${issue.code === "invalid_type" ? "is required" : issue.message}`,
  );
  throw new Error(`Invalid environment (.env):\n${problems.join("\n")}`);
}

import { z } from "zod";

/** Empty values in .env (KEY=) count as not set. */
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

/** 32 bytes: 64 hex characters, or base64 (43 characters plus one "="). Checked without Buffer so the schema also builds for the browser. */
const KEY_32_BYTES = /^(?:[0-9a-fA-F]{64}|[A-Za-z0-9+/]{43}=)$/;

const HOST = /^[a-zA-Z0-9.-]+$/;
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"];

/** Environment of the api and the worker (one .env in the repository root). Later milestones add their keys here. */
export const ServerEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

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
     * The address the browser uses (behind tailscale serve: https://storm.example.com:8100). The live events
     * socket then accepts only this Origin; unset, the Origin must match the Host header (development).
     */
    APP_ORIGIN: optional(z.url({ protocol: /^https?$/ }).transform((url) => new URL(url).origin)),

    ANTHROPIC_API_KEY: optional(z.string()),
    /** Default models per task group; Settings (ModelSetting) override them per task. */
    LLM_MODEL_CLASSIFY: optional(z.string().regex(/^claude-[a-z0-9-]+$/, "a Claude model id, e.g. claude-haiku-5-5")),
    LLM_MODEL_WRITING: optional(z.string().regex(/^claude-[a-z0-9-]+$/, "a Claude model id, e.g. claude-sonnet-5-5")),
    LLM_MODEL_REFLECTION: optional(z.string().regex(/^claude-[a-z0-9-]+$/, "a Claude model id, e.g. claude-opus-5-5")),
    LLM_MODEL_BUILDER: optional(z.string().regex(/^claude-[a-z0-9-]+$/, "a Claude model id, e.g. claude-opus-5-5")),
    /** Builder chat (README §2.1): a chat stops answering once its calls used this many tokens; a new chat starts over. */
    BUILDER_CHAT_MAX_TOKENS: z.coerce.number().int().positive().default(2_000_000),
    /** Non-essential pipelines pause when this month's LLM cost reaches it. Settings override it; unset = no limit. */
    LLM_MONTHLY_BUDGET_USD: optional(z.coerce.number().positive()),

    /**
     * Embeddings for few-shot retrieval (README §8): OpenAI, 1024 dimensions (the Examples.embedding column).
     * Unset: drafts are written without examples; nothing else changes.
     */
    OPENAI_API_KEY: optional(z.string()),
    EMBEDDINGS_MODEL: z.enum(["text-embedding-3-large", "text-embedding-3-small"]).default("text-embedding-3-large"),

    /**
     * Browser (README §6). Files the pipelines produce (screenshots, traces, downloads) live here; the worker writes,
     * the api serves them to me.
     */
    ARTIFACTS_DIR: z.string().min(1).default("data/artifacts"),
    /** Live view: x11vnc's passwords, full control and view-only (VNC uses the first 8 characters). Unset: no live view. */
    VNC_PASSWORD: optional(z.string().min(8)),
    VNC_VIEW_PASSWORD: optional(z.string().min(8)),
    /** A run waiting for me in the live view gives up after this long (its step fails). */
    TAKEOVER_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(120).default(30),
    /** Downloads larger than this are rejected in quarantine. */
    DOWNLOAD_MAX_MB: z.coerce.number().int().min(1).max(500).default(25),

    /** notify.telegram: messages go to this chat only. */
    TELEGRAM_BOT_TOKEN: optional(z.string().regex(/^\d+:[\w-]{30,}$/, "a bot token from @BotFather (123456:ABC...)")),
    TELEGRAM_CHAT_ID: optional(z.string().regex(/^-?\d+$/, "a numeric chat id")),

    /**
     * Mail (email.* steps): IMAP and SMTP with an app password. The address and the app password are a credential
     * (Credentials page) named MAIL_CREDENTIAL, whose allowed hosts include both servers; nothing secret goes here.
     */
    MAIL_CONNECTOR: z.enum(["imap"]).default("imap"),
    IMAP_HOST: optional(z.string().regex(HOST, "a host name, e.g. imap.gmail.com")),
    IMAP_PORT: z.coerce.number().int().min(1).max(65535).default(993),
    SMTP_HOST: optional(z.string().regex(HOST, "a host name, e.g. smtp.gmail.com")),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
    /** TLS from the first byte (993/465). "false" only for a local test server: refused for any other host. */
    MAIL_TLS: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    MAIL_CREDENTIAL: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "a credential name")
      .default("mail"),
  })
  .refine((env) => env.MAIL_TLS || [env.IMAP_HOST, env.SMTP_HOST].every((host) => !host || LOCAL_HOSTS.includes(host)), {
    path: ["MAIL_TLS"],
    message: "can be false only for a local mail server (localhost, 127.0.0.1): the app password must not travel unencrypted",
  });

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

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

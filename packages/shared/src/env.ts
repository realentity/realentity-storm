import { z } from "zod";

/** Empty values in .env (KEY=) count as not set. */
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

/** 32 bytes: 64 hex characters, or base64 (43 characters plus one "="). Checked without Buffer so the schema also builds for the browser. */
const KEY_32_BYTES = /^(?:[0-9a-fA-F]{64}|[A-Za-z0-9+/]{43}=)$/;

/** Environment of the api and the worker (one .env in the repository root). Later milestones add their keys here. */
export const ServerEnvSchema = z.object({
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

  ANTHROPIC_API_KEY: optional(z.string()),
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

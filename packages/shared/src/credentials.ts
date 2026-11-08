import { z } from "zod";

export const CredentialKind = {
  PASSWORD: "PASSWORD",
  TOTP_SEED: "TOTP_SEED",
  API_KEY: "API_KEY",
  OAUTH_TOKEN: "OAUTH_TOKEN",
  STORAGE_STATE: "STORAGE_STATE",
  /** A PostgreSQL connection URL for db.query (M29-T7). */
  DATABASE: "DATABASE",
} as const;
export type CredentialKind = (typeof CredentialKind)[keyof typeof CredentialKind];

/** An exact host ("linkedin.com") or an explicit subdomain wildcard ("*.linkedin.com"). Lowercase, no scheme, port or path. */
export const HOST_PATTERN = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$|^localhost$/;

/**
 * A host a credential may go to: a name as above, or (M29-T7, a database on the same host or a private network) an IPv4
 * address or a single name such as a Docker service ("postgres").
 */
export const CREDENTIAL_HOST = new RegExp(`${HOST_PATTERN.source}|^(\\d{1,3}\\.){3}\\d{1,3}$|^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`);

/** What a PostgreSQL connection URL connects to, without its password; null when it isn't one. */
export function databaseConnection(url: string): { host: string; port: number; database: string | null; user: string | null } | null {
  try {
    const parsed = new URL(url.trim());
    if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname) return null;
    return {
      host: parsed.hostname.toLowerCase(),
      port: parsed.port ? Number(parsed.port) : 5432,
      database: decodeURIComponent(parsed.pathname.replace(/^\//, "")) || null,
      user: parsed.username ? decodeURIComponent(parsed.username) : null,
    };
  } catch {
    return null;
  }
}

/** The host of a PostgreSQL connection URL, lowercase; null when it isn't one. */
export function databaseHost(url: string): string | null {
  return databaseConnection(url)?.host ?? null;
}

/** Why a DATABASE credential's value can't be stored with these hosts; null when it can. Never quotes the value. */
export function databaseProblem(secret: string, allowedHosts: readonly string[]): string | null {
  const host = databaseHost(secret);
  if (!host) return "the connection string must be a URL: postgresql://user:password@host:5432/database";
  return allowedHosts.includes(host) ? null : `the database's host (${host}) must be one of its allowed hosts`;
}

/** A credential name as referenced in pipelines: {{cred:<name>}}. */
export const CREDENTIAL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Upper bound for one secret; Playwright storageState can be large. */
export const MAX_SECRET_LENGTH = 1_000_000;

const secret = z.string().min(1).max(MAX_SECRET_LENGTH);

export const CreateCredentialSchema = z
  .object({
    name: z.string().regex(CREDENTIAL_NAME, "lowercase letters, digits, '.', '_' or '-'"),
    allowedHosts: z
      .array(z.string().trim().toLowerCase().regex(CREDENTIAL_HOST, "an exact host, *.host or an IP address"))
      .min(1)
      .max(20)
      .transform((hosts) => [...new Set(hosts)]),
    username: z.string().max(320).optional(),
    kind: z.enum(CredentialKind),
    secret,
  })
  .superRefine((credential, issues) => {
    if (credential.kind !== CredentialKind.DATABASE) return;
    // Never the value in the message: only what is wrong with it.
    const problem = databaseProblem(credential.secret, credential.allowedHosts);
    if (problem) issues.addIssue({ code: "custom", path: [], message: problem });
  });
export type CreateCredentialRequest = z.infer<typeof CreateCredentialSchema>;

export const ReplaceCredentialSecretSchema = z.object({ secret });
export type ReplaceCredentialSecretRequest = z.infer<typeof ReplaceCredentialSecretSchema>;

/** What the API returns about a credential: metadata only, never the value or any encrypted part. */
export interface CredentialView {
  credentialId: string;
  name: string;
  allowedHosts: string[];
  username: string | null;
  kind: CredentialKind;
  keyVersion: number;
  lastUsedAt: string | null;
  dateCreated: string;
  dateUpdated: string;
}

/** True when `host` may receive a credential bound to `patterns` (exact match, or a subdomain of an explicit "*." pattern). */
export function hostMatches(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return patterns.some((pattern) => {
    if (pattern.startsWith("*.")) {
      const base = pattern.slice(2);
      return h.endsWith(`.${base}`);
    }
    return h === pattern;
  });
}

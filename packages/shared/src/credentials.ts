import { z } from "zod";

export const CredentialKind = {
  PASSWORD: "PASSWORD",
  TOTP_SEED: "TOTP_SEED",
  API_KEY: "API_KEY",
  OAUTH_TOKEN: "OAUTH_TOKEN",
  STORAGE_STATE: "STORAGE_STATE",
} as const;
export type CredentialKind = (typeof CredentialKind)[keyof typeof CredentialKind];

/** An exact host ("linkedin.com") or an explicit subdomain wildcard ("*.linkedin.com"). Lowercase, no scheme, port or path. */
export const HOST_PATTERN = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$|^localhost$/;

/** A credential name as referenced in pipelines: {{cred:<name>}}. */
export const CREDENTIAL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Upper bound for one secret; Playwright storageState can be large. */
export const MAX_SECRET_LENGTH = 1_000_000;

const secret = z.string().min(1).max(MAX_SECRET_LENGTH);

export const CreateCredentialSchema = z.object({
  name: z.string().regex(CREDENTIAL_NAME, "lowercase letters, digits, '.', '_' or '-'"),
  allowedHosts: z
    .array(z.string().trim().toLowerCase().regex(HOST_PATTERN, "an exact host or *.host"))
    .min(1)
    .max(20)
    .transform((hosts) => [...new Set(hosts)]),
  username: z.string().max(320).optional(),
  kind: z.enum(CredentialKind),
  secret,
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

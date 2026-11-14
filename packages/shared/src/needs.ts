import { z } from "zod";
import { HOST_PATTERN } from "./credentials";

/**
 * M50: what a pipeline or an App needs, by slot, never by a credential's name: "a GitHub credential", "a database",
 * "the repository". `{{cred:github}}` and `{{setting.repository}}` refer to its slots; which of the user's credentials
 * (by id) or what text fills each is a binding, chosen when it is built, edited, installed or imported.
 */

/** A slot's name: lowercase letters, digits, _ and -; no dot, so {{setting.repository}} reads one way. */
export const SLOT_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** The kinds of credential a slot may ask for (CredentialKind, lowercase). */
export const CREDENTIAL_TYPES = ["password", "api_key", "database", "oauth_token", "storage_state", "totp_seed"] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

const Label = z.string().trim().min(1).max(200);

export const CredentialNeedSchema = z
  .object({
    kind: z.literal("credential"),
    /** What kind of credential: a database's connection URL, an API key, a password. Any when left out. */
    type: z.enum(CREDENTIAL_TYPES).optional(),
    /** The host it is for (api.github.com): only a credential allowed there fits. */
    for: z.string().trim().toLowerCase().regex(HOST_PATTERN, "a host, e.g. api.github.com").optional(),
    label: Label.optional(),
  })
  .strict();

export const TextNeedSchema = z
  .object({
    kind: z.literal("text"),
    label: Label.optional(),
    /** Shown in its input: me/infra. */
    example: z.string().max(200).optional(),
  })
  .strict();

export const NeedSchema = z.discriminatedUnion("kind", [CredentialNeedSchema, TextNeedSchema]);
export type Need = z.infer<typeof NeedSchema>;

export const NeedsSchema = z
  .record(z.string().regex(SLOT_NAME, "lowercase letters, digits, _ or -, e.g. github"), NeedSchema)
  .refine((needs) => Object.keys(needs).length <= 20, "at most 20");
export type Needs = z.infer<typeof NeedsSchema>;

/** {{cred:slot}} anywhere in a text. */
export const CRED_REFERENCE = /\{\{\s*cred:([a-z0-9][a-z0-9_-]{0,39})\s*\}\}/g;

/** The slot of a value that is exactly {{cred:slot}}; null otherwise. */
export function credSlotOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^\{\{\s*cred:([a-z0-9][a-z0-9_-]{0,39})\s*\}\}$/.exec(value.trim())?.[1] ?? null;
}

/** A binding as the api shows it: the slot, what it needs, and what fills it. */
export interface BindingView {
  slot: string;
  need: Need;
  /** Where it is declared: the pipeline's own, or its App's (shared by the App's pipelines). */
  owner: "pipeline" | "app";
  /** The credential filling it, by id, with its name for the page; null: not set. */
  credential: { credentialId: string; name: string } | null;
  /** A text setting's value; null: not set. */
  text: string | null;
}

/** M50: setting one slot: a credential by id, or a text (null clears it). */
export const BindingRequestSchema = z
  .object({
    credentialId: z.uuid().nullable().optional(),
    text: z.string().max(2000).nullable().optional(),
  })
  .strict();
export type BindingRequest = z.infer<typeof BindingRequestSchema>;

/** Every slot of a pipeline or an App, set or not. */
export const BindingsRequestSchema = z.record(z.string().regex(SLOT_NAME), BindingRequestSchema);
export type BindingsRequest = z.infer<typeof BindingsRequestSchema>;

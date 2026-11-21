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
/**
 * What it takes to fill the slot, shown under it and on the credential form opened from it: a token's scopes or
 * permissions, where to create one. Plain text; a line break starts a line.
 */
const Help = z.string().trim().min(1).max(1000);

export const CredentialNeedSchema = z
  .object({
    kind: z.literal("credential"),
    /** What kind of credential: a database's connection URL, an API key, a password. Any when left out. */
    type: z.enum(CREDENTIAL_TYPES).optional(),
    /** The host it is for (api.github.com): only a credential allowed there fits. */
    for: z.string().trim().toLowerCase().regex(HOST_PATTERN, "a host, e.g. api.github.com").optional(),
    label: Label.optional(),
    help: Help.optional(),
  })
  .strict();

export const TextNeedSchema = z
  .object({
    kind: z.literal("text"),
    label: Label.optional(),
    help: Help.optional(),
    /** Shown in its input: me/infra. */
    example: z.string().max(200).optional(),
  })
  .strict();

/** M50-T7: one of the user's email accounts; not filled, the default one. */
export const EmailNeedSchema = z.object({ kind: z.literal("email"), label: Label.optional(), help: Help.optional() }).strict();

/** What a Google account is used for: its calendar, its Drive (read-only); the user allows each at the sign-in. */
export const GOOGLE_USES = ["calendar", "drive"] as const;
export type GoogleUse = (typeof GOOGLE_USES)[number];

/** M50-T8: one of the user's Google accounts, allowing what it `uses`; not filled, the default one. */
export const GoogleNeedSchema = z
  .object({
    kind: z.literal("google"),
    uses: z.array(z.enum(GOOGLE_USES)).min(1).optional(),
    label: Label.optional(),
    help: Help.optional(),
  })
  .strict();

/** The kinds of slot an account fills (not a credential, not text): never empty, the default account until one is chosen. */
export const ACCOUNT_KINDS = ["email", "google"] as const;

export const NeedSchema = z.discriminatedUnion("kind", [CredentialNeedSchema, TextNeedSchema, EmailNeedSchema, GoogleNeedSchema]);
export type Need = z.infer<typeof NeedSchema>;

export const NeedsSchema = z
  .record(z.string().regex(SLOT_NAME, "lowercase letters, digits, _ or -, e.g. github"), NeedSchema)
  .refine((needs) => Object.keys(needs).length <= 20, "at most 20");
export type Needs = z.infer<typeof NeedsSchema>;

/** {{cred:slot}} anywhere in a text. */
export const CRED_REFERENCE = /\{\{\s*cred:([a-z0-9][a-z0-9_-]{0,39})\s*\}\}/g;
/** {{setting.slot}} anywhere in a text. */
export const SETTING_REFERENCE = /\{\{\s*setting\.([a-z0-9][a-z0-9_-]{0,39})\s*\}\}/g;

/** M50-T7, M50-T8: the steps that go through one of the user's accounts, and which kind: their `account` is a slot. */
export const ACCOUNT_STEPS: Readonly<Record<string, "email" | "google">> = {
  "email.fetch": "email",
  "email.awaiting": "email",
  "email.send": "email",
  "calendar.find": "google",
  "calendar.create": "google",
};

/**
 * The slots a pipeline's steps use, as the compiler finds them: {{cred:…}} and {{setting.…}} in a step's inputs, and an
 * account step's `account` written as a name ("topics" and one from data aren't slots). A pipeline of an App needs only
 * the App's slots it uses: Server ops' monitors run without the database its database check reads.
 */
export function slotsUsed(steps: readonly { type: string; with?: Record<string, unknown> }[]): Set<string> {
  const used = new Set<string>();
  for (const step of steps) {
    const inputs = step.with ?? {};
    const account = Object.hasOwn(ACCOUNT_STEPS, step.type) ? inputs.account : undefined;
    if (typeof account === "string" && account !== "topics" && SLOT_NAME.test(account)) used.add(account);
    for (const value of Object.values(inputs)) {
      const text = JSON.stringify(value ?? null);
      for (const [, slot] of text.matchAll(CRED_REFERENCE)) used.add(slot);
      for (const [, slot] of text.matchAll(SETTING_REFERENCE)) used.add(slot);
    }
  }
  return used;
}

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
  /** M50-T7, M50-T8: an email or google slot's account (its address); null: the default one. */
  account: { id: string; name: string } | null;
  /** M50-T4: a credential slot's candidates (the user's credentials that fit it), or an account slot's (their accounts). */
  fits: { id: string; name: string }[];
}

/** M50-T13: the slots not filled: a setting with no text, a credential slot with none. An account slot is never empty: without one chosen, the default account. */
export function emptySlots(views: readonly BindingView[]): BindingView[] {
  return views.filter((v) =>
    v.need.kind === "email" || v.need.kind === "google"
      ? false
      : v.need.kind === "credential"
        ? v.credential === null
        : v.text === null || v.text === "",
  );
}

/** M50: setting one slot: a credential by id, or a text (null clears it). */
export const BindingRequestSchema = z
  .object({
    credentialId: z.uuid().nullable().optional(),
    text: z.string().max(2000).nullable().optional(),
    /** M50-T7: an email slot's account. */
    emailAccountId: z.uuid().nullable().optional(),
    /** M50-T8: a google slot's account. */
    googleAccountId: z.uuid().nullable().optional(),
  })
  .strict();
export type BindingRequest = z.infer<typeof BindingRequestSchema>;

/** Every slot of a pipeline or an App, set or not. */
export const BindingsRequestSchema = z.record(z.string().regex(SLOT_NAME), BindingRequestSchema);
export type BindingsRequest = z.infer<typeof BindingsRequestSchema>;

import { z } from "zod";

/**
 * M62: the connections Storm itself uses, set up in Settings → AI (docs/design.md §5, §7): Claude, and model servers
 * with an OpenAI-compatible API (Ollama, LM Studio, vLLM, OpenAI). Their secrets are write-only: only a hint comes back.
 */
export const INTEGRATION_KINDS = ["CLAUDE", "OPENAI_COMPATIBLE"] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

/** The authenticator code, asked again for a change that could send your data elsewhere (M62-T6). */
const Code = z.string().regex(/^\d{6}$/, "the 6-digit code from your authenticator app");
const Name = z.string().trim().min(1).max(80);
/** Up to and including /v1, e.g. http://host.docker.internal:11434/v1 (Ollama from Storm's containers). */
const BaseUrl = z.url({ protocol: /^https?$/ }).max(500);
const Secret = z.string().trim().min(1).max(1000);

export const IntegrationCreateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("CLAUDE"), name: Name.default("Claude"), secret: Secret, code: Code }).strict(),
  z.object({ kind: z.literal("OPENAI_COMPATIBLE"), name: Name, baseUrl: BaseUrl, secret: Secret.optional(), code: Code }).strict(),
]);
export type IntegrationCreate = z.input<typeof IntegrationCreateSchema>;

/** `code` is needed when `baseUrl` or `secret` changes; `secret: null` removes a server's key. */
export const IntegrationUpdateSchema = z
  .object({ name: Name.optional(), enabled: z.boolean().optional(), baseUrl: BaseUrl.optional(), secret: Secret.nullable().optional(), code: Code.optional() })
  .strict();
export type IntegrationUpdate = z.infer<typeof IntegrationUpdateSchema>;

export interface IntegrationView {
  integrationId: string;
  kind: IntegrationKind;
  name: string;
  enabled: boolean;
  /** A model server's address; null for Claude. */
  baseUrl: string | null;
  /** The secret's last four characters ("…a1b2"); null without one. The secret itself is never returned. */
  secretHint: string | null;
  dateUpdated: string;
}

/** Test (M62-T2): the server's models, and a short structured answer from one of them. */
export const IntegrationTestSchema = z.object({ model: z.string().min(1).max(300).optional() }).strict();

export interface IntegrationTestView {
  ok: boolean;
  /** The models it offers, by their name there. */
  models: string[];
  /** The model the test asked, and how long its answer took. */
  model: string | null;
  seconds: number | null;
  error: string | null;
}

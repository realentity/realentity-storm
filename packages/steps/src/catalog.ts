import { type TargetKind } from "@ai-me/shared";
import { z } from "zod";

/**
 * One step type in the catalog (README §2.3). The builder may only use catalog steps, and new capabilities are
 * added by writing a new step, never by the LLM. Implementations live in the worker; this is the shared metadata.
 */
export interface StepDefinition {
  type: string;
  description: string;
  /** Sends, submits or uploads something outside the system: always behind a gate.act, never retried automatically. */
  sideEffect: boolean;
  /** Input fields that name an external target, checked by the policy layer (README §2.2). Side-effect steps only. */
  targets?: Record<string, TargetKind>;
  /** May receive {{cred:name}} references (browser steps). Everything else, the LLM steps above all, may not. */
  acceptsCredentials?: boolean;
  /** Usable in the multi-user product: no stored site passwords, no restricted scopes (README §17). */
  saasSafe: boolean;
  /**
   * Drives the headed browser: runs containing it are serialized (one virtual display, README §6). "input": only when
   * the step's `headed` parameter is true.
   */
  headed?: boolean | "input";
  /** Its output may contain text an LLM wrote: a side-effect target can never come from it (README §2.2). */
  llmOutput?: boolean;
  /**
   * The output field that is my text once I approve it (README §8): when a side-effect payload field is exactly
   * {{thisStep.<field>}}, its approved value becomes a few-shot example for this step type.
   */
  learns?: string;
  input: z.ZodObject;
  output: z.ZodObject;
}

export class StepCatalog {
  private readonly steps = new Map<string, StepDefinition>();

  constructor(definitions: Iterable<StepDefinition> = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: StepDefinition): this {
    if (this.steps.has(definition.type)) throw new Error(`Step type ${definition.type} is already registered`);
    if (definition.targets && !definition.sideEffect) throw new Error(`${definition.type}: only side-effect steps have targets`);
    for (const field of Object.keys(definition.targets ?? {})) {
      if (!(field in definition.input.shape)) throw new Error(`${definition.type}: target "${field}" is not an input field`);
    }
    if (definition.learns && !(definition.learns in definition.output.shape)) {
      throw new Error(`${definition.type}: learns "${definition.learns}" is not an output field`);
    }
    this.steps.set(definition.type, definition);
    return this;
  }

  get(type: string): StepDefinition | undefined {
    return this.steps.get(type);
  }

  list(): StepDefinition[] {
    return [...this.steps.values()];
  }

  /** A copy with extra steps (tests, later milestones). */
  with(...definitions: StepDefinition[]): StepCatalog {
    return new StepCatalog([...this.steps.values(), ...definitions]);
  }

  /** Whether a pipeline needs the headed browser for any of its steps. */
  needsHeaded(steps: readonly { type: string; with?: Record<string, unknown> }[]): boolean {
    return steps.some((step) => {
      const headed = this.get(step.type)?.headed;
      return headed === true || (headed === "input" && step.with?.headed === true);
    });
  }
}

const Items = z.array(z.record(z.string(), z.unknown())).describe("list of objects");

/**
 * One fetched email (email.fetch). Text only: attachments are listed, never downloaded. `from` and `replyTo` are
 * addresses as the message carries them, so a reply's recipient can be checked against them (provenance).
 */
export const EmailMessageSchema = z.object({
  uid: z.number().int(),
  messageId: z.string(),
  /** The thread's first Message-ID (References, else In-Reply-To, else its own). */
  threadId: z.string(),
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),
  from: z.string(),
  fromName: z.string().nullable(),
  replyTo: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  subject: z.string(),
  date: z.string(),
  text: z.string(),
  attachments: z.array(z.object({ filename: z.string().nullable(), contentType: z.string(), size: z.number().int() })),
});
export type EmailMessage = z.infer<typeof EmailMessageSchema>;

const Messages = z.array(EmailMessageSchema).describe("list of emails");

const FilterCondition = z.object({
  field: z.string().min(1),
  op: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "in"]),
  value: z.unknown(),
});

const Selector = z.string().min(1).max(500);

/** The steps available so far: data, LLM, gates and notifications (M2), email (M4), browser (M8). More browser and file steps join in M9–M11. */
export const CORE_STEPS: StepDefinition[] = [
  {
    type: "data.dedupe",
    description: "Removes items whose `key` field repeats, keeping the first.",
    sideEffect: false,
    saasSafe: true,
    input: z.object({ from: Items, key: z.string().min(1) }),
    output: z.object({ items: Items, duplicates: z.number().int() }),
  },
  {
    type: "data.filter",
    description: "Keeps items matching every condition.",
    sideEffect: false,
    saasSafe: true,
    input: z.object({ items: Items, where: z.array(FilterCondition).min(1) }),
    output: z.object({ items: Items, removed: z.number().int() }),
  },
  {
    type: "llm.classify",
    description: "Labels each item with the LLM following `instruction`; items with a `keep` label go to `kept`.",
    sideEffect: false,
    llmOutput: true,
    saasSafe: true,
    input: z.object({
      items: Items,
      instruction: z.string().min(1),
      labels: z.array(z.string().min(1)).min(2).default(["keep", "drop"]),
      keep: z.array(z.string().min(1)).min(1).default(["keep"]),
    }),
    output: z.object({
      kept: Items,
      dropped: Items,
      results: z.array(z.object({ index: z.number().int(), label: z.string(), reason: z.string() })),
    }),
  },
  {
    type: "llm.score",
    description: "Scores each item 0–100 against `against` (a profile or criteria text); `top` keeps the best N.",
    sideEffect: false,
    llmOutput: true,
    saasSafe: true,
    input: z.object({
      items: Items,
      against: z.string().min(1),
      instruction: z.string().optional(),
      top: z.number().int().min(1).max(100).optional(),
    }),
    output: z.object({ scored: Items, top: Items }),
  },
  {
    type: "llm.generate",
    description: "Writes text following `instruction`, using `context`.",
    sideEffect: false,
    llmOutput: true,
    learns: "text",
    saasSafe: true,
    input: z.object({
      instruction: z.string().min(1),
      context: z.unknown().optional(),
      format: z.enum(["text", "markdown"]).default("text"),
    }),
    output: z.object({ text: z.string() }),
  },
  {
    type: "llm.summarize",
    description: "Summarizes `content`.",
    sideEffect: false,
    llmOutput: true,
    saasSafe: true,
    input: z.object({
      content: z.unknown(),
      instruction: z.string().optional(),
      maxWords: z.number().int().min(10).max(2000).default(150),
    }),
    output: z.object({ summary: z.string() }),
  },
  {
    type: "gate.review",
    description: "Pauses the run so I can pick which items proceed.",
    sideEffect: false,
    saasSafe: true,
    input: z.object({ items: Items, mode: z.enum(["select"]).default("select"), title: z.string().max(200).optional() }),
    output: z.object({ selected: Items }),
  },
  {
    type: "gate.act",
    description: "Shows the exact payload of the side-effect step named in `for`; it runs only after I press Act.",
    sideEffect: false,
    saasSafe: true,
    input: z.object({ for: z.string().min(1) }),
    output: z.object({ approved: z.boolean() }),
  },
  {
    type: "notify.telegram",
    description: "Sends me a Telegram message (to me only).",
    sideEffect: false,
    saasSafe: true,
    input: z.object({ text: z.string().min(1).max(4000) }),
    output: z.object({ sent: z.boolean() }),
  },
  {
    type: "notify.digest",
    description: "Sends me a Telegram digest of the last `hours`: what ran, what waits for me, what failed.",
    sideEffect: false,
    saasSafe: true,
    input: z.object({ hours: z.number().int().min(1).max(168).default(24) }),
    output: z.object({ sent: z.boolean(), text: z.string() }),
  },
  {
    type: "email.fetch",
    description:
      "Reads the emails that arrived since this pipeline's last run (its first run looks back `sinceDays`), oldest first, " +
      "so each email is read once; read-only (IMAP), nothing is marked or moved.",
    sideEffect: false,
    saasSafe: true,
    input: z.object({
      mailbox: z.string().min(1).max(200).default("INBOX"),
      limit: z.number().int().min(1).max(200).default(50),
      /** The first run of a pipeline looks back this far; later runs continue where the last one stopped. */
      sinceDays: z.number().int().min(1).max(60).default(2),
    }),
    output: z.object({ messages: Messages }),
  },
  {
    type: "email.classify",
    description: "Labels each email with the LLM following `instruction`; emails with a `keep` label go to `kept`.",
    sideEffect: false,
    llmOutput: true,
    saasSafe: true,
    input: z.object({
      messages: Messages,
      instruction: z.string().min(1),
      labels: z.array(z.string().min(1)).min(2).default(["reply", "skip"]),
      keep: z.array(z.string().min(1)).min(1).default(["reply"]),
    }),
    output: z.object({
      kept: Messages,
      dropped: Messages,
      results: z.array(z.object({ index: z.number().int(), label: z.string(), reason: z.string() })),
    }),
  },
  {
    type: "email.draftReply",
    description: "Drafts a reply to `message` in my voice, in the email's language, without inventing facts.",
    sideEffect: false,
    llmOutput: true,
    learns: "body",
    saasSafe: true,
    input: z.object({
      message: EmailMessageSchema,
      instruction: z.string().min(1),
      /** What the reply may draw on besides the email (my availability, rates, links). */
      context: z.unknown().optional(),
      signature: z.string().max(500).optional(),
    }),
    // No recipient: it always comes from the fetched email, never from the LLM.
    output: z.object({ subject: z.string(), body: z.string(), language: z.string() }),
  },
  {
    type: "email.send",
    description:
      "Sends an email from my mailbox (SMTP); with `inReplyTo` (and the original's `references`) a reply in the same " +
      "thread: the message replied to is added to the references.",
    sideEffect: true,
    targets: { to: "recipient" },
    saasSafe: true,
    input: z.object({
      to: z.email(),
      subject: z.string().min(1).max(998),
      body: z.string().min(1).max(100_000),
      inReplyTo: z.string().optional(),
      references: z.array(z.string()).max(100).optional(),
    }),
    output: z.object({ messageId: z.string(), accepted: z.array(z.string()) }),
  },
  {
    type: "browser.open",
    description:
      "Opens a page in the browser and returns its text; can sign in with a stored credential first (kept signed in " +
      "between runs). Read-only: it submits nothing but the sign-in. Headed runs can be watched live, and I take over " +
      "when it meets a CAPTCHA, a 2FA prompt or a page it doesn't recognize.",
    sideEffect: false,
    acceptsCredentials: true,
    headed: "input",
    saasSafe: false,
    input: z.object({
      url: z.url({ protocol: /^https?$/ }),
      /** The watchable browser (live view): for sign-ins and anything I may have to take over. */
      headed: z.boolean().default(false).describe("watchable in the live view; one headed run at a time"),
      login: z
        .object({
          credential: z.string().regex(/^\{\{\s*cred:[a-z0-9][a-z0-9._-]{0,63}\s*\}\}$/, 'a credential reference, e.g. "{{cred:jobs-bg}}"'),
          username: Selector.optional().describe("the username field; default: the first email/text field of the sign-in form"),
          password: Selector.optional().describe("default: the password field"),
          submit: Selector.optional().describe("default: the form's submit button"),
        })
        .optional()
        .describe("signs in when the page shows a password field; only on the credential's allowed hosts"),
      waitFor: Selector.optional().describe("the page is ready when this appears; if it doesn't, I take over"),
      timeoutSeconds: z.number().int().min(5).max(120).default(30),
    }),
    output: z.object({
      url: z.string(),
      title: z.string(),
      text: z.string(),
      signedIn: z.boolean().describe("it filled the sign-in form in this run"),
    }),
  },
];

export const defaultCatalog = (): StepCatalog => new StepCatalog(CORE_STEPS);

import { type TargetKind } from "@ai-me/shared";
import { z } from "zod";
import { RecipeNameSchema } from "./recipe";

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
  /** Output fields of an llmOutput step that come from the page, not the LLM (a form's address): they may be targets. */
  pageFields?: string[];
  /**
   * The output field that is my text once I approve it (README §8): when a side-effect payload field is exactly
   * {{thisStep.<field>}}, its approved value becomes a few-shot example for this step type.
   */
  learns?: string;
  /**
   * Input fields that are addresses the step reads from (http.fetch, M13): a literal one must be on the pipeline's
   * `policy.allowedDomains`, and at run time every one is checked against it.
   */
  reads?: string[];
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
/** A product variant by its attributes (shop.product), e.g. { size: "M", color: "Black" }. */
const Select = z.record(z.string().min(1).max(40), z.string().min(1).max(100));

/** Where data.save and data.dedupe keep and look up items. */
export const SAVED_LISTS = ["JobPosting"] as const;

/** A collection of my own for data.save and data.history (M13). */
export const COLLECTION = /^[a-z][a-z0-9._-]{0,63}$/;

/** A stored document (Documents page), e.g. "cv-main". */
export const DOCUMENT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DocumentName = z.string().regex(DOCUMENT_NAME, 'a document name, e.g. "cv-main"');

export const FORM_FIELD_TYPES = ["text", "email", "tel", "url", "number", "date", "textarea", "select", "radio", "checkbox", "file"] as const;

/** One field of an external form, as browser.mapForm read it, with the value to type (README §2.2, map → gate → act). */
export const FormFieldSchema = z.object({
  /** How the field is found on the page (a CSS selector browser.mapForm built from its id or name). */
  key: z.string().min(1).max(500),
  label: z.string().max(300),
  type: z.enum(FORM_FIELD_TYPES),
  required: z.boolean(),
  /** select and radio: the choices. */
  options: z.array(z.string().max(300)).max(200).optional(),
  /** What to type or pick; a checkbox: true or false; null: left as it is. File fields get files, not values. */
  value: z.union([z.string().max(10_000), z.boolean()]).nullable(),
  /** Where the value came from: my profile, written for this job, or nothing. */
  source: z.enum(["profile", "written", "none"]).default("none"),
  /**
   * A question that checks I'm a person ("104-43="): never answered by the step; I answer it in the live view before
   * the form goes (it may change on every load).
   */
  human: z.boolean().optional(),
});
export type FormField = z.infer<typeof FormFieldSchema>;

/** A stored document attached to a file field: bound by content, so a document replaced after approval doesn't go. */
export const FormFileSchema = z.object({
  key: z.string().min(1).max(500),
  document: DocumentName,
  documentId: z.uuid(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  filename: z.string().min(1).max(200),
});
export type FormFile = z.infer<typeof FormFileSchema>;

/** One of my stored documents, bound by content (file.read's output, browser.upload's file). */
export const DocumentFileSchema = FormFileSchema.omit({ key: true });

/**
 * An element browser.agent acted on, as browser.submit finds it again: a CSS selector built from the page (its id,
 * its name, or its position under the nearest id), checked against the role and name the agent saw.
 */
export const ElementTargetSchema = z.object({
  css: z.string().min(1).max(500),
  role: z.string().max(40),
  name: z.string().max(300),
});
export type ElementTarget = z.infer<typeof ElementTargetSchema>;

/** One action of browser.agent's fixed set (README §2.4), as browser.submit repeats it. Attach uses an approved file only. */
export const AgentActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), url: z.url({ protocol: /^https?$/ }) }),
  z.object({ kind: z.literal("click"), target: ElementTargetSchema }),
  z.object({
    kind: z.literal("type"),
    target: ElementTargetSchema,
    value: z.string().max(10_000),
    source: z.enum(["profile", "written", "none"]).default("none"),
  }),
  z.object({ kind: z.literal("select"), target: ElementTargetSchema, value: z.string().max(300) }),
  z.object({ kind: z.literal("check"), target: ElementTargetSchema, value: z.boolean() }),
  z.object({ kind: z.literal("attach"), target: ElementTargetSchema, document: DocumentName }),
]);
export type AgentAction = z.infer<typeof AgentActionSchema>;

/** The steps available so far: data, LLM, gates and notifications (M2), email (M4), browser (M8), recipes and jobs (M9), forms (M10), the agent (M11). */
export const CORE_STEPS: StepDefinition[] = [
  {
    type: "data.dedupe",
    description:
      "Removes items whose `key` field repeats, keeping the first; with `against: JobPosting`, also the jobs saved " +
      "before (by data.save), so each posting comes through once.",
    sideEffect: false,
    saasSafe: true,
    input: z.object({
      from: Items,
      key: z.string().min(1),
      against: z.enum(SAVED_LISTS).optional().describe("also drop items whose key is already saved there (key: the posting's url)"),
    }),
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
    type: "data.save",
    description:
      "Saves items and says what changed since the last save. Default: as job postings (by `url`; title, company, " +
      "location, description, score, scoreReason, source) for the Jobs page and deduplication; a posting saved again " +
      "keeps its first-seen date and `status` only moves forward (NEW → SKIPPED or SHORTLISTED; APPLIED stays). With " +
      "`collection`: into that named list, one item per `key`; `changed` compares `fields` (default every field); " +
      "`complete: true` means the items are the whole list, so missing ones are `removed`.",
    sideEffect: false,
    saasSafe: true,
    input: z.object({
      items: Items,
      into: z.enum(SAVED_LISTS).default("JobPosting"),
      status: z.enum(["NEW", "SKIPPED", "SHORTLISTED"]).default("NEW"),
      collection: z.string().regex(COLLECTION, "lowercase letters, digits, . _ -, e.g. releases").optional().describe("a list of my own instead of JobPosting"),
      key: z.string().min(1).optional().describe("the field that identifies an item in the collection, e.g. url or id"),
      fields: z.array(z.string().min(1)).min(1).optional().describe("the fields whose change counts (default: all)"),
      complete: z.boolean().default(false).describe("the items are the whole list: saved ones missing from it are removed"),
    }),
    output: z.object({
      saved: z.number().int(),
      created: z.number().int(),
      skipped: z.number().int(),
      /** Not saved before. */
      added: Items,
      /** Saved before with other values in `fields`: the item, and those fields before and after. */
      changed: z.array(
        z.object({ key: z.string(), item: z.record(z.string(), z.unknown()), before: z.record(z.string(), z.unknown()), after: z.record(z.string(), z.unknown()) }),
      ),
      /** With `complete: true`, saved before and missing now (the last saved values). */
      removed: Items,
    }),
  },
  {
    type: "data.history",
    description:
      "Keeps a number per item over time (a price, a count) in `collection` by `key`, and adds `history` to each item: " +
      "previous, change, changePct, min, max, count, direction (new, up, down, same), lowest (the lowest so far). The " +
      "value may be text such as \"1 299,00 лв.\". Filter on it with data.filter, e.g. history.change lt 0.",
    sideEffect: false,
    saasSafe: true,
    input: z.object({
      items: Items,
      collection: z.string().regex(COLLECTION, "lowercase letters, digits, . _ -, e.g. prices"),
      key: z.string().min(1),
      value: z.string().min(1).describe("the field holding the number"),
      keep: z.number().int().min(2).max(365).default(60).describe("values kept per key"),
    }),
    output: z.object({ items: Items, recorded: z.number().int(), unreadable: z.number().int() }),
  },
  {
    type: "http.fetch",
    description:
      "Reads addresses without a browser (GET only, no cookies): RSS/Atom feeds become `items` (title, url, published, " +
      "summary, id, source), JSON is `json` (a list, or the list at `itemsAt`, also becomes `items`), anything else " +
      "`text`. Only hosts in policy.allowedDomains, never private or tailnet addresses. Unchanged since the last read " +
      "(ETag / Last-Modified), it reuses what it read then.",
    sideEffect: false,
    saasSafe: true,
    reads: ["url", "urls"],
    input: z.object({
      url: z.string().url().optional(),
      urls: z.array(z.string().url()).min(1).max(25).optional(),
      itemsAt: z.string().min(1).optional().describe("for JSON: the dotted path of the list to use as items, e.g. data.items"),
      maxItems: z.number().int().min(1).max(500).default(100),
      maxKb: z.number().int().min(1).max(5120).default(1024),
      timeoutSeconds: z.number().int().min(2).max(60).default(20),
    }),
    output: z.object({
      items: Items,
      json: z.unknown(),
      text: z.string(),
      documents: z.array(
        z.object({
          url: z.string(),
          status: z.number().int(),
          notModified: z.boolean(),
          contentType: z.string(),
          title: z.string().nullable(),
          truncated: z.boolean(),
        }),
      ),
    }),
  },
  {
    type: "shop.product",
    description:
      "The price of a product, or of one variant (select: { size: M, color: Black }), from its page: one item per " +
      "product (id, url, title, brand, price as a number, currency, availability, inStock, variant, problem). Reads the " +
      "page's schema.org data or price meta tags without a browser; a page without them, or one that refuses, opens in " +
      "the headless browser, and with no data there either the cheap model reads the price from its text. `id` is the " +
      "product and the variant asked for: the key for data.history. Only hosts in policy.allowedDomains.",
    sideEffect: false,
    saasSafe: true,
    reads: ["url", "urls", "products"],
    input: z.object({
      url: z.string().url().optional(),
      urls: z.array(z.string().url()).min(1).max(25).optional(),
      products: z
        .array(z.object({ url: z.string().url(), select: Select.optional() }))
        .min(1)
        .max(25)
        .optional()
        .describe("products with their own variant each"),
      select: Select.optional().describe("the variant, for url / urls: attribute: value, e.g. { size: M, color: Black }"),
      browser: z.enum(["fallback", "always", "never"]).default("fallback"),
      llm: z.boolean().default(true).describe("no product data even in the browser: the cheap model reads the page's text"),
      timeoutSeconds: z.number().int().min(5).max(120).default(30),
    }),
    output: z.object({ items: Items, problems: z.array(z.string()) }),
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
  {
    type: "browser.extract",
    description:
      "Reads a list (e.g. job postings) from a site with saved recipes (Recipes page), headless and without an LLM: " +
      "every page up to the recipe's limit, each item's fields plus `source` (the recipe). A list param runs one " +
      "search per value. Read-only. Fails clearly, and marks the recipe broken, when the page no longer matches it; " +
      "with `fallback`, browser.agent finds the list instead and a fixed recipe is proposed for me to approve, read with now.",
    sideEffect: false,
    saasSafe: false,
    input: z.object({
      recipes: z.array(RecipeNameSchema).min(1).max(5).describe('saved recipes, e.g. ["dev.bg/search"]'),
      params: z
        .record(z.string(), z.union([z.string(), z.array(z.string()).min(1).max(10)]))
        .default({})
        .describe("the recipes' params; a list: one search per value"),
      maxItems: z.number().int().min(1).max(500).default(200),
      fallback: z.boolean().default(false).describe("a broken recipe: the agent finds the list and proposes a fix (LLM cost)"),
      timeoutSeconds: z.number().int().min(5).max(120).default(30),
    }),
    output: z.object({ items: Items, pages: z.number().int() }),
  },
  {
    type: "browser.teach",
    description:
      "Teach mode: opens `url` in the live browser; I bring it to the list to read and press Continue; the LLM " +
      "proposes a recipe from the page, it is checked on the page (items outlined), and Continue saves it as the next " +
      "version of `recipe`. Used once per site, not in scheduled pipelines.",
    sideEffect: false,
    headed: true,
    llmOutput: true,
    saasSafe: false,
    input: z.object({
      recipe: RecipeNameSchema,
      url: z.url({ protocol: /^https?$/ }),
      params: z
        .record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/), z.string().min(1).max(200))
        .default({})
        .describe('values in the list address that become params, e.g. { category: "net" }'),
      fields: z
        .array(z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/))
        .min(1)
        .max(15)
        .default(["url", "title", "company", "location", "posted"]),
      hint: z.string().max(1000).optional().describe("what to read or avoid, for the LLM"),
    }),
    output: z.object({ recipe: z.string(), version: z.number().int().nullable(), url: z.string(), items: Items }),
  },
  {
    type: "browser.mapForm",
    description:
      "Opens an application form (following the page's Apply button when the form isn't there) and reads every field, " +
      "typing and attaching nothing. Proposes each value from my profile (Settings) and writes free-text answers " +
      "following `message`; attaches the stored document `cv` to the CV field. Its output is the payload for " +
      "browser.fillAndSubmit, which I see and edit at the gate.",
    sideEffect: false,
    llmOutput: true,
    pageFields: ["formUrl"],
    saasSafe: false,
    input: z.object({
      url: z.url({ protocol: /^https?$/ }),
      headed: z.boolean().default(false).describe("watchable in the live view; one headed run at a time"),
      cv: DocumentName.optional().describe('the stored document for the CV / résumé field, e.g. "cv-main"'),
      message: z.string().max(2000).optional().describe("how to write free-text answers (a message to the employer)"),
      job: z.record(z.string(), z.unknown()).optional().describe("the posting (title, company, url), for the answers and Applications"),
      timeoutSeconds: z.number().int().min(5).max(120).default(30),
    }),
    output: z.object({
      formUrl: z.string().describe("the address of the form, as the page has it"),
      fields: z.array(FormFieldSchema),
      files: z.array(FormFileSchema),
      submit: z.string().describe("the label of the form's final button"),
      notes: z.string().describe("fields left empty and why"),
    }),
  },
  {
    type: "browser.fillAndSubmit",
    description:
      "Fills an application form with exactly the approved fields and files and submits it, in the live browser. " +
      "Before typing it reads the form again: a field that changed, a new required field or another address pauses " +
      "the run for me, and nothing is submitted. With stopBeforeSubmit it fills everything and I press the final " +
      "button myself.",
    sideEffect: true,
    targets: { url: "domain" },
    headed: true,
    saasSafe: false,
    input: z.object({
      url: z.url({ protocol: /^https?$/ }),
      fields: z.array(FormFieldSchema),
      files: z.array(FormFileSchema).default([]),
      stopBeforeSubmit: z.boolean().default(false).describe("fill, then I submit in the live view"),
      job: z.string().optional().describe("the posting's url: its Application is marked submitted"),
      timeoutSeconds: z.number().int().min(5).max(120).default(30),
    }),
    output: z.object({
      submitted: z.boolean().describe("the form was sent (by the step, or by me when stopBeforeSubmit)"),
      url: z.string(),
      confirmation: z.string().describe("the page's text after sending"),
    }),
  },
  {
    type: "browser.download",
    description:
      "Downloads a file: the address itself, or what clicking `click` on that page downloads. It lands in quarantine " +
      "and is kept only when its size and its content (not its name) are an allowed type: PDF, images, Office " +
      "documents, text. Read-only.",
    sideEffect: false,
    headed: "input",
    saasSafe: false,
    input: z.object({
      url: z.url({ protocol: /^https?$/ }),
      click: Selector.optional().describe("the link or button that starts the download; default: the address is the file"),
      headed: z.boolean().default(false).describe("watchable in the live view; one headed run at a time"),
      timeoutSeconds: z.number().int().min(5).max(120).default(30),
    }),
    output: z.object({ artifactId: z.string(), filename: z.string(), mime: z.string(), size: z.number().int(), sha256: z.string() }),
  },
  {
    type: "browser.upload",
    description:
      "Puts one of my stored documents (`file`, from file.read) into the file field `field` on `url`, and presses " +
      "`submit` if given, in the live browser. Choosing a file uploads it on many sites: always behind a gate.",
    sideEffect: true,
    targets: { url: "domain" },
    headed: true,
    saasSafe: false,
    input: z.object({
      url: z.url({ protocol: /^https?$/ }),
      field: Selector.describe("the file input"),
      file: DocumentFileSchema.describe("a stored document, bound by content: file.read's output"),
      submit: Selector.optional().describe("a button to press once the file is chosen"),
      timeoutSeconds: z.number().int().min(5).max(120).default(30),
    }),
    output: z.object({ uploaded: z.boolean(), url: z.string(), confirmation: z.string() }),
  },
  {
    type: "file.read",
    description:
      "Reads the text of one of my stored documents (`document`, e.g. cv-main) or of a file browser.download " +
      "kept (`artifact`): text files as they are, PDFs' text. Its output also binds a document by content for " +
      "browser.upload.",
    sideEffect: false,
    saasSafe: true,
    input: z.object({
      document: DocumentName.optional(),
      artifact: z.uuid().optional().describe("a download's artifactId"),
      maxChars: z.number().int().min(100).max(100_000).default(20_000),
    }),
    output: z.object({
      filename: z.string(),
      mime: z.string(),
      sha256: z.string(),
      text: z.string(),
      truncated: z.boolean(),
      document: z.string().nullable(),
      documentId: z.string().nullable(),
      artifactId: z.string().nullable(),
    }),
  },
  {
    type: "browser.agent",
    description:
      "An LLM works the page towards `goal` (find the apply button and fill the form, read something) on a site " +
      "without a recipe, from the page's accessibility outline: navigate, click, type, select, tick, attach one of " +
      "`documents`, read. Only on the start address's site and the pipeline's allowed domains, at most `maxActions` " +
      "actions. It sends nothing: no submit button is pressed, nothing typed leaves the page, no file is picked. " +
      "Its recorded actions and final button are the payload of browser.submit, which I see at the gate.",
    sideEffect: false,
    llmOutput: true,
    pageFields: ["url"],
    headed: "input",
    saasSafe: false,
    input: z.object({
      url: z.url({ protocol: /^https?$/ }),
      goal: z.string().min(1).max(2000).describe("what to do, e.g. find the application form and fill it from my profile"),
      headed: z.boolean().default(false).describe("watchable in the live view; one headed run at a time"),
      documents: z.array(DocumentName).max(5).default([]).describe('stored documents it may attach, e.g. ["cv-main"]'),
      message: z.string().max(2000).optional().describe("how to write free-text answers (a message to the employer)"),
      job: z.record(z.string(), z.unknown()).optional().describe("the posting (title, company, url), for the answers and Applications"),
      maxActions: z.number().int().min(1).max(50).default(25),
      timeoutSeconds: z.number().int().min(5).max(120).default(30),
    }),
    output: z.object({
      url: z.string().describe("the start address, as given"),
      outcome: z.enum(["ready", "done"]).describe("ready: a form filled and its final button found; done: nothing to send"),
      answer: z.string().describe("what it found or did"),
      actions: z.array(AgentActionSchema),
      files: z.array(FormFileSchema),
      submit: ElementTargetSchema.nullable().describe("the final button (ready)"),
      pageUrl: z.string().describe("where it ended"),
      notes: z.string(),
    }),
  },
  {
    type: "browser.submit",
    description:
      "Repeats an approved browser.agent run exactly, without an LLM, in the live browser, and presses its final " +
      "button. An element that is no longer there, or a page off the allowed sites, pauses the run for me with " +
      "nothing sent. With stopBeforeSubmit I press the final button myself.",
    sideEffect: true,
    targets: { url: "domain" },
    headed: true,
    saasSafe: false,
    input: z.object({
      url: z.url({ protocol: /^https?$/ }),
      actions: z.array(AgentActionSchema).max(100),
      files: z.array(FormFileSchema).default([]),
      submit: ElementTargetSchema,
      stopBeforeSubmit: z.boolean().default(false).describe("fill, then I submit in the live view"),
      job: z.string().optional().describe("the posting's url: its Application is marked submitted"),
      timeoutSeconds: z.number().int().min(5).max(120).default(30),
    }),
    output: z.object({
      submitted: z.boolean().describe("the form was sent (by the step, or by me when stopBeforeSubmit)"),
      url: z.string(),
      confirmation: z.string().describe("the page's text after sending"),
    }),
  },
];

export const defaultCatalog = (): StepCatalog => new StepCatalog(CORE_STEPS);

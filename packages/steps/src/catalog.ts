import { defaultTimeZone, isTimeZone, TYPE_NAME, type FieldKind, type TargetKind } from "@realentity/storm-shared";
import jsonata from "jsonata";
import { z } from "zod";
import { RecipeNameSchema } from "./recipe";

/** data.map's expression parses (M29): a mistake shows when the pipeline is saved, not on its first run. */
function isJsonata(expression: string): boolean {
  try {
    jsonata(expression);
    return true;
  } catch {
    return false;
  }
}

/**
 * One step type in the catalog (docs/design.md §2.3). The builder may only use catalog steps, and new capabilities are
 * added by writing a new step, never by the LLM. Implementations live in the worker; this is the shared metadata.
 */
export interface StepDefinition {
  type: string;
  description: string;
  /** Sends, submits or uploads something outside the system: always behind a gate.act, never retried automatically. */
  sideEffect: boolean;
  /** Input fields that name an external target, checked by the policy layer (docs/design.md §2.2). Side-effect steps only. */
  targets?: Record<string, TargetKind>;
  /**
   * May receive {{cred:name}} references (browser steps); a list: only in those input fields (http.fetch's headers and
   * query, M29). Everything else, the LLM steps above all, may not.
   */
  acceptsCredentials?: boolean | readonly string[];
  /** Usable in a multi-user product: no stored site passwords, no restricted scopes. */
  saasSafe: boolean;
  /**
   * Drives the headed browser: runs containing it are serialized (one virtual display, docs/design.md §6). "input": only when
   * the step's `headed` parameter is true.
   */
  headed?: boolean | "input";
  /**
   * Calls the LLM, so the monthly budget applies (docs/design.md §5, M19-T1): once it is reached, a non-essential run stops
   * before this step. browser.extract isn't one: only its fallback calls the LLM, and that checks the budget itself.
   */
  llm?: boolean;
  /** Its output may contain text an LLM wrote: a side-effect target can never come from it (docs/design.md §2.2). */
  llmOutput?: boolean;
  /** Output fields of an llmOutput step that come from the page, not the LLM (a form's address): they may be targets. */
  pageFields?: string[];
  /**
   * Inputs not required but nearly always given (http.fetch's `url`, one of `url` or `urls`): shown on its card with
   * the required ones, not under More.
   */
  primary?: string[];
  /**
   * The output field that is the user's text once approved (docs/design.md §8): when a side-effect payload field is
   * exactly {{thisStep.<field>}}, its approved value becomes a few-shot example for this step type.
   */
  learns?: string;
  /**
   * An output field holding a short plain-text account of what the step read (shop.product: each product's price): a
   * run that ends with nothing to tell (its message skipped by `when`) shows it in its summary.
   */
  reports?: string;
  /**
   * Input fields that are addresses the step reads from (http.fetch, M13): a literal one must be on the pipeline's
   * `policy.allowedDomains`, and at run time every one is checked against it.
   */
  reads?: string[];
  /**
   * The entity types it writes or reads, which its pipeline's App must have (M33): that key, these fields of these
   * kinds, these states when it sets the stage. The App may have more fields; the compiler checks these are there.
   */
  entities?: EntityContract[];
  input: z.ZodObject;
  output: z.ZodObject;
}

export interface EntityContract {
  type: string;
  key: string;
  fields: Record<string, FieldKind>;
  states?: string[];
  /** A type of mine the step reads (price.watch's Product); otherwise one it writes, so never mine. */
  mine?: boolean;
  /**
   * The step works outside an App too (on what the old pages kept, until they go: M33-T4): the type is checked only
   * when its pipeline names an App.
   */
  optional?: boolean;
}

/** bill.save's Bill (M33): the type a Bills App gives it. */
export const BILL_ENTITY: EntityContract = {
  type: "Bill",
  key: "billKey",
  fields: {
    billKey: "text",
    issuer: "text",
    issuerKey: "text",
    amount: "money",
    currency: "text",
    dueDate: "date",
    month: "date",
    period: "text",
    reference: "text",
    from: "email",
    subject: "text",
    messageId: "text",
  },
  states: ["due", "paid"],
};

/** A job and the user's application to it (M33): what the job steps and application.outcome move through its stages. */
export const JOB_ENTITY: EntityContract = {
  type: "Job",
  key: "url",
  optional: true,
  fields: { url: "url", title: "text", company: "text", location: "text", description: "longtext", score: "number", scoreReason: "longtext", source: "text" },
  states: ["new", "skipped", "shortlisted", "prepared", "applied", "responded", "interview", "rejected"],
};

/** price.watch's Product (M33): a type of mine, a shop per line of `shops` ("https://… | size: M, color: Black"). */
export const PRODUCT_ENTITY: EntityContract = {
  type: "Product",
  key: "name",
  mine: true,
  fields: { name: "text", targetPrice: "money", currency: "text", enabled: "yesno", shops: "list" },
};

/** price.watch's Offer (M33): what it read last on one shop's page for one product. */
export const OFFER_ENTITY: EntityContract = {
  type: "Offer",
  key: "offer",
  fields: {
    offer: "text",
    product: "text",
    shop: "text",
    url: "url",
    variant: "text",
    price: "money",
    currency: "text",
    inStock: "yesno",
    title: "text",
    problem: "text",
    checkedAt: "datetime",
  },
};

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
    if (definition.reports && !(definition.reports in definition.output.shape)) {
      throw new Error(`${definition.type}: reports "${definition.reports}" is not an output field`);
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

/** http.fetch's headers (M29-T5): a token, as HTTP allows; the ones the connection itself sets can't be given. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
const FIXED_HEADERS = ["host", "connection", "content-length", "transfer-encoding", "cookie"];
const HttpHeaders = z
  .record(z.string(), z.string().max(8000))
  .refine((headers) => Object.keys(headers).every((name) => HEADER_NAME.test(name)), "header names are letters, digits and -, e.g. Authorization")
  .refine((headers) => Object.keys(headers).every((name) => !FIXED_HEADERS.includes(name.toLowerCase())), `not ${FIXED_HEADERS.join(", ")}`)
  .optional()
  .describe('request headers, e.g. Authorization: "Bearer {{cred:github}}"');
const HttpQuery = z
  .record(z.string().min(1).max(100), z.string().max(2000))
  .optional()
  .describe('added to the address\'s query, e.g. appid: "{{cred:openweather}}"');

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
/** A date and time: ISO 8601 with an offset (2026-11-12T10:00:00+02:00, …Z), or without one (read in `timeZone`). */
const DateTimeText = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/, "an ISO 8601 date and time, e.g. 2026-11-12T10:00:00+02:00");
const TimeZone = z
  .string()
  .default(defaultTimeZone)
  .refine(isTimeZone, "an IANA time zone, e.g. Europe/London")
  .describe("for times without an offset (default: the server's time zone)");
/** A product variant by its attributes (shop.product), e.g. { size: "M", color: "Black" }. */
const Select = z.record(z.string().min(1).max(40), z.string().min(1).max(100));

/** Where data.save and data.dedupe keep and look up items. */
export const SAVED_LISTS = ["JobPosting"] as const;

/** A collection of the user's own for data.save and data.history (M13). */
export const COLLECTION = /^[a-z][a-z0-9._-]{0,63}$/;

/** A stored document (Documents page), e.g. "cv-main". */
export const DOCUMENT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DocumentName = z.string().regex(DOCUMENT_NAME, 'a document name, e.g. "cv-main"');

/** Where a value typed into a form came from (M10, M15). */
export const ANSWER_SOURCES = ["profile", "written", "fact", "asked", "none"] as const;

export const FORM_FIELD_TYPES = ["text", "email", "tel", "url", "number", "date", "textarea", "select", "radio", "checkbox", "file"] as const;

/** One field of an external form, as browser.mapForm read it, with the value to type (docs/design.md §2.2, map → gate → act). */
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
  /** Where the value came from: the user's profile, written for this job, a fact, an answer to a question, or nothing. */
  source: z.enum(ANSWER_SOURCES).default("none"),
  /** The fact it came from (source fact or asked, M15): the gate shows it. */
  fact: z.object({ factId: z.uuid(), question: z.string().max(300) }).optional(),
  /**
   * A question that checks for a person ("104-43="): never answered by the step; the user answers it in the live view
   * before the form goes (it may change on every load).
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

/** One of the user's stored documents, bound by content (file.read's output, browser.upload's file). */
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

/** One action of browser.agent's fixed set (docs/design.md §2.4), as browser.submit repeats it. Attach uses an approved file only. */
export const AgentActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("navigate"), url: z.url({ protocol: /^https?$/ }) }),
  z.object({ kind: z.literal("click"), target: ElementTargetSchema }),
  z.object({
    kind: z.literal("type"),
    target: ElementTargetSchema,
    value: z.string().max(10_000),
    source: z.enum(ANSWER_SOURCES).default("none"),
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
      "before (by data.save), so each posting comes through once; with `againstType` (a type of the pipeline's App, " +
      "M33), the items whose key is already an entity of it.",
    sideEffect: false,
    saasSafe: true,
    input: z.object({
      from: Items,
      key: z.string().min(1),
      against: z.enum(SAVED_LISTS).optional().describe("also drop items whose key is already saved there (key: the posting's url)"),
      againstType: z.string().regex(TYPE_NAME).optional().describe("also drop items whose key is already an entity of this type of the pipeline's App"),
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
      "`complete: true` means the items are the whole list, so missing ones are `removed`. With `type` (a type of the " +
      "pipeline's App, M30): as entities of that type, by its key; each field read as its kind, a wrong one left out " +
      "and said in `invalid`, an item without a required field not saved.",
    sideEffect: false,
    saasSafe: true,
    input: z.object({
      items: Items,
      into: z.enum(SAVED_LISTS).default("JobPosting"),
      status: z.enum(["NEW", "SKIPPED", "SHORTLISTED"]).default("NEW"),
      collection: z.string().regex(COLLECTION, "lowercase letters, digits, . _ -, e.g. releases").optional().describe("a list of the user's own instead of JobPosting"),
      key: z.string().min(1).optional().describe("the field that identifies an item in the collection, e.g. url or id"),
      fields: z.array(z.string().min(1)).min(1).optional().describe("the fields whose change counts (default: all)"),
      complete: z.boolean().default(false).describe("the items are the whole list: saved ones missing from it are removed"),
      type: z.string().regex(TYPE_NAME, "a type of the pipeline's App, e.g. Job").optional().describe("an entity type of the pipeline's App instead of a collection"),
      stage: z.string().trim().min(1).max(40).optional().describe("with type: move each item to this stage, as its type's moves allow a pipeline (M33)"),
    }),
    output: z.object({
      /** A dry run: that nothing was saved, and what a run would save (the counts are that). */
      preview: z.string().optional(),
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
      /** With `type`: items with fields that aren't their kind (left out), or not saved (`saved: false`). */
      invalid: z.array(z.object({ key: z.string().nullable(), saved: z.boolean(), problems: z.array(z.string()) })).default([]),
    }),
  },
  {
    type: "data.read",
    description:
      "Reads entities of a type of the pipeline's App (M30), as items: their fields, mine included. `where` keeps " +
      "those matching every condition (as data.filter, on the type's fields), `sort` orders them (\"-salary\": highest " +
      "first), `limit` caps them; `removed: true` reads the removed ones instead.",
    sideEffect: false,
    saasSafe: true,
    input: z.object({
      type: z.string().regex(TYPE_NAME, "a type of the pipeline's App, e.g. Job"),
      where: z.array(FilterCondition).min(1).optional(),
      sort: z.string().regex(/^-?[A-Za-z_@][\w.@-]*$/, '"field" or "-field"').optional(),
      limit: z.number().int().min(1).max(1000).default(100),
      removed: z.boolean().default(false),
    }),
    output: z.object({ items: Items, count: z.number().int() }),
  },
  {
    type: "data.history",
    description:
      "Keeps a number per item over time (a price, a count) in `collection` by `key`, and adds `history` to each item: " +
      "previous, change, changePct, min, max, count, direction (new, up, down, same), lowest (the lowest so far), " +
      "usualChange (the median change between the earlier values, once there are 3) and vsUsual (change ÷ usualChange: " +
      "3 is three times the usual growth). The value may be text such as \"1 299,00 лв.\". Filter on it with " +
      "data.filter, e.g. history.change lt 0, or tell once with data.alert, e.g. history.vsUsual above 3.",
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
    type: "data.map",
    description:
      "Reshapes JSON (an API's answer, a step's items) into `items` with a JSONata expression. One item per hour from " +
      "parallel arrays: `$map(hourly.time, function($t, $i) { { \"time\": $t, \"temp\": hourly.temperature_2m[$i] } })`; " +
      "one summary item: `{ \"place\": \"Sofia\", \"min\": $min(hourly.temperature_2m) }`. A list of objects becomes the " +
      "items, one object a single item, anything else { value }. Write `{ {` with a space: `{{` starts a reference. " +
      "It reads only its input: no network, no code, stopped after a second.",
    sideEffect: false,
    saasSafe: true,
    input: z.object({
      from: z.unknown().describe("the JSON to read, e.g. {{forecast.json}} or {{search.items}}"),
      expression: z.string().min(1).max(4000).refine(isJsonata, "a JSONata expression (see jsonata.org)").describe("JSONata"),
      maxItems: z.number().int().min(1).max(5000).default(500),
    }),
    output: z.object({ items: Items, value: z.unknown() }),
  },
  {
    type: "data.alert",
    description:
      "Tells once when a number crosses a line, and once when it is back: each item's `value` against `below` or " +
      "`above`, per `key`, remembered between runs. `crossed` has the items that went past the line in this run, " +
      "`cleared` those back past `clearAt` (default: the line; set it a little further, e.g. below 10 and clearAt 12, " +
      "so a value going back and forth isn't told every time). Each gets `alert` (value, line, since); `text` says " +
      "both, a line each, for a message with `when`. A dry run remembers nothing.",
    sideEffect: false,
    saasSafe: true,
    input: z
      .object({
        items: Items,
        key: z.string().min(1).describe("the field naming what is measured, e.g. place or table"),
        value: z.string().min(1).describe("the field holding the number, e.g. min or history.vsUsual"),
        below: z.number().optional(),
        above: z.number().optional(),
        clearAt: z.number().optional().describe("back to normal past this (default: the line)"),
        label: z.string().min(1).optional().describe("the field naming an item in `text` (default: key)"),
      })
      .refine((input) => (input.below === undefined) !== (input.above === undefined), "either below or above")
      .refine(
        ({ below, above, clearAt }) =>
          clearAt === undefined || (below !== undefined ? clearAt >= below : above === undefined || clearAt <= above),
        "clearAt is on the normal side of the line: at or over `below`, at or under `above`",
      ),
    output: z.object({
      crossed: Items,
      cleared: Items,
      /** Past the line after this run, these included. */
      active: z.number().int(),
      text: z.string(),
      unreadable: z.number().int(),
    }),
  },
  {
    type: "http.fetch",
    description:
      "Reads addresses without a browser (GET only, no cookies): RSS/Atom feeds become `items` (title, url, published, " +
      "summary, id, source), JSON is `json` (a list, or the list at `itemsAt`, also becomes `items`), anything else " +
      "`text`. Only hosts in policy.allowedDomains, never private or CGNAT/Tailscale addresses. Unchanged since the last read " +
      "(ETag / Last-Modified), it reuses what it read then. An API key goes in `headers` or `query` as {{cred:name}} " +
      "(a stored credential): it is sent only to the hosts the credential allows, also after a redirect.",
    sideEffect: false,
    saasSafe: true,
    reads: ["url", "urls"],
    primary: ["url"],
    acceptsCredentials: ["headers", "query"],
    input: z.object({
      url: z.string().url().optional(),
      urls: z.array(z.string().url()).min(1).max(25).optional(),
      headers: HttpHeaders,
      query: HttpQuery,
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
    type: "http.request",
    description:
      "Changes something at an API: one POST, PUT, PATCH or DELETE, with `body` sent as JSON. A side effect: it waits " +
      "at its gate, which shows the method, address, headers and body, until the user presses Act. The address's host is a " +
      "target (policy.allowedDomains, or approved at the gate); never a private or CGNAT/Tailscale address, and a redirect " +
      "isn't followed. An API key goes in `headers` or `query` as {{cred:name}}, sent only to the hosts the credential " +
      "allows. An answer other than 2xx fails the step. Output: status, json (when the answer is JSON), text.",
    sideEffect: true,
    targets: { url: "domain" },
    acceptsCredentials: ["headers", "query"],
    saasSafe: true,
    input: z.object({
      method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
      url: z.url({ protocol: /^https?$/ }),
      headers: HttpHeaders,
      query: HttpQuery,
      body: z.unknown().optional().describe("sent as JSON, e.g. { title: ..., labels: [storm] }"),
      timeoutSeconds: z.number().int().min(2).max(60).default(20),
    }),
    output: z.object({ status: z.number().int(), json: z.unknown(), text: z.string() }),
  },
  {
    type: "db.query",
    description:
      "Reads a PostgreSQL database: one SQL query, its rows as items (column names as fields; counts as numbers, dates " +
      "as ISO text). `connection` is {{cred:name}}, a database credential: its connection URL, the server among its " +
      "allowed hosts (the only way to reach a private or CGNAT/Tailscale address). Read-only: the query runs as a subquery " +
      "(SELECT, VALUES, WITH … SELECT), one statement, in a READ ONLY transaction rolled back afterwards, stopped after " +
      "`timeoutSeconds`; at most `maxRows` rows (`truncated` says there were more). Values as $1, $2 from `params`, " +
      "never pasted into the SQL. Use a database user that may only read.",
    sideEffect: false,
    saasSafe: false,
    acceptsCredentials: ["connection"],
    input: z.object({
      connection: z.string().regex(/^\{\{\s*cred:[a-z0-9._-]+\s*\}\}$/, "a database credential, {{cred:name}}"),
      sql: z.string().min(1).max(20_000).describe("one query that reads, e.g. SELECT relname AS table, n_live_tup AS rows FROM pg_stat_user_tables"),
      params: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).max(50).default([]).describe("the values of $1, $2, …"),
      maxRows: z.number().int().min(1).max(5000).default(500),
      timeoutSeconds: z.number().int().min(1).max(60).default(10),
    }),
    output: z.object({ items: Items, rows: z.number().int(), truncated: z.boolean(), columns: z.array(z.string()) }),
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
    llm: true,
    saasSafe: true,
    reads: ["url", "urls", "products"],
    reports: "report",
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
    output: z.object({
      items: Items,
      problems: z.array(z.string()),
      report: z.string().describe('one line per product: "Jacket (M, Black): 343.16 EUR, in stock"'),
    }),
  },
  {
    type: "llm.classify",
    description: "Labels each item with the LLM following `instruction`; items with a `keep` label go to `kept`.",
    sideEffect: false,
    llm: true,
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
    entities: [JOB_ENTITY],
    description: "Scores each item 0–100 against `against` (a profile or criteria text); `top` keeps the best N.",
    sideEffect: false,
    llm: true,
    llmOutput: true,
    saasSafe: true,
    input: z.object({
      items: Items,
      against: z.string().min(1),
      instruction: z.string().optional(),
      top: z.number().int().min(1).max(100).optional(),
      outcomes: z
        .boolean()
        .default(false)
        .describe("job postings: the user's applications' outcomes (interviews, rejections, no answer) calibrate the scores"),
    }),
    output: z.object({ scored: Items, top: Items }),
  },
  {
    type: "llm.generate",
    description: "Writes text following `instruction`, using `context`.",
    sideEffect: false,
    llm: true,
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
    llm: true,
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
    type: "llm.extract",
    description:
      "Reads named fields out of `content` (an email, a page's text) with the LLM: `fields` maps each name to what it " +
      "is. `values` has each as text (\"\" when the content doesn't say), `missing` the ones it doesn't, `found` is " +
      "true when none is missing. Dates and times come as ISO 8601 with the offset the content implies (else " +
      "`timeZone`'s), e.g. 2026-11-12T10:00:00+02:00.",
    sideEffect: false,
    llm: true,
    llmOutput: true,
    saasSafe: true,
    input: z.object({
      content: z.unknown(),
      fields: z
        .record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/), z.string().min(1).max(300))
        .refine((fields) => Object.keys(fields).length >= 1 && Object.keys(fields).length <= 20, "1 to 20 fields")
        .describe('e.g. { start: "when the interview starts", company: "the company" }'),
      instruction: z.string().max(2000).optional(),
      timeZone: TimeZone,
    }),
    output: z.object({ values: z.record(z.string(), z.string()), missing: z.array(z.string()), found: z.boolean() }),
  },
  {
    type: "application.outcome",
    entities: [JOB_ENTITY],
    description:
      "What an email says about one of the user's submitted applications: matched by the company and role (the sender's " +
      "domain or the company's name first), and the application moved on: replied, interview, rejected (forward " +
      "only; the date kept, the email noted; application.status emitted, which cancels a follow-up flow.later). " +
      "matched false when it isn't about one (an automatic \"we received it\" isn't an answer). A dry run moves nothing.",
    sideEffect: false,
    llm: true,
    llmOutput: true,
    saasSafe: true,
    input: z.object({ message: EmailMessageSchema }),
    output: z.object({
      matched: z.boolean(),
      applicationId: z.string().nullable(),
      job: z.object({ title: z.string(), company: z.string().nullable(), url: z.string() }).nullable(),
      status: z.enum(["RESPONDED", "INTERVIEW", "REJECTED"]).nullable(),
      changed: z.boolean().describe("the status moved (false: it was there already, or a dry run)"),
      reason: z.string(),
    }),
  },
  {
    type: "gate.review",
    description: "Pauses the run so the user can pick which items proceed.",
    sideEffect: false,
    saasSafe: true,
    input: z.object({ items: Items, mode: z.enum(["select"]).default("select"), title: z.string().max(200).optional() }),
    output: z.object({ selected: Items }),
  },
  {
    type: "gate.act",
    description: "Shows the exact payload of the side-effect step named in `for`; it runs only after the user presses Act.",
    sideEffect: false,
    saasSafe: true,
    input: z.object({ for: z.string().min(1) }),
    output: z.object({ approved: z.boolean() }),
  },
  {
    type: "notify.telegram",
    description: "Sends the user a Telegram message (to the user only).",
    sideEffect: false,
    saasSafe: true,
    input: z.object({ text: z.string().min(1).max(4000) }),
    output: z.object({ sent: z.boolean() }),
  },
  {
    type: "notify.digest",
    description: "Sends the user a Telegram digest of the last `hours`: what ran, what waits for the user, what failed.",
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
    description:
      "Labels each email with the LLM following `instruction`; emails with a `keep` label go to `kept`. With `answerable` " +
      "(on when `keep` has `reply`), an email that can't be answered (a no-reply sender, or the user's own to themselves) is never kept.",
    sideEffect: false,
    llm: true,
    llmOutput: true,
    saasSafe: true,
    input: z.object({
      messages: Messages,
      instruction: z.string().min(1),
      labels: z.array(z.string().min(1)).min(2).default(["reply", "skip"]),
      keep: z.array(z.string().min(1)).min(1).default(["reply"]),
      /** Only answerable emails may be kept: the rest are dropped without the LLM. Default: on when `keep` has "reply". */
      answerable: z.boolean().optional(),
    }),
    output: z.object({
      kept: Messages,
      dropped: Messages,
      results: z.array(z.object({ index: z.number().int(), label: z.string(), reason: z.string() })),
    }),
  },
  {
    type: "email.draftReply",
    description: "Drafts a reply to `message` in the user's voice, in the email's language, without inventing facts.",
    sideEffect: false,
    llm: true,
    llmOutput: true,
    learns: "body",
    saasSafe: true,
    input: z.object({
      message: EmailMessageSchema,
      instruction: z.string().min(1),
      /** What the reply may draw on besides the email (the user's availability, rates, links). */
      context: z.unknown().optional(),
      signature: z.string().max(500).optional(),
    }),
    // No recipient: it always comes from the fetched email, never from the LLM.
    output: z.object({ subject: z.string(), body: z.string(), language: z.string() }),
  },
  {
    type: "email.awaiting",
    description:
      "The user's sent emails that got no answer (M22): threads whose last message is the user's (the Sent folder), older than " +
      "`afterDays`, with nothing from the other side in `mailbox` since. Each of the user's emails is listed once ever: a " +
      "thread comes back only when the user writes in it again. Draft the nudge with email.draftFollowUp (message: " +
      "{{item.message}}) and send it with email.send to {{item.to}}, inReplyTo {{item.message.messageId}}, " +
      "references {{item.references}}. Read-only.",
    sideEffect: false,
    saasSafe: true,
    input: z.object({
      afterDays: z.number().int().min(1).max(60).default(5).describe("how long without an answer before a follow-up"),
      lookbackDays: z.number().int().min(7).max(90).default(30).describe("sent emails older than this are left alone"),
      mailbox: z.string().min(1).max(200).default("INBOX").describe("where answers arrive"),
      sentMailbox: z.string().min(1).max(200).optional().describe("default: the server's Sent folder"),
      maxFollowUps: z.number().int().min(1).max(3).default(1).describe("follow-ups in a row without an answer, at most"),
      limit: z.number().int().min(1).max(20).default(5),
    }),
    output: z.object({
      threads: z.array(
        z.object({
          threadId: z.string(),
          to: z.string().describe("who the user's email went to (its first To)"),
          subject: z.string(),
          sentAt: z.string(),
          daysWaiting: z.number().int(),
          followUps: z.number().int().describe("follow-ups already sent in a row"),
          message: EmailMessageSchema.describe("the user's email that got no answer"),
          references: z.array(z.string()).describe("the thread so far, for email.send"),
        }),
      ),
    }),
  },
  {
    type: "email.draftFollowUp",
    description:
      "Drafts a short, polite follow-up to `message`, the user's own email that got no answer: in its language, asking " +
      "whether they had a chance to look, without new facts or pressure.",
    sideEffect: false,
    llm: true,
    llmOutput: true,
    learns: "body",
    saasSafe: true,
    input: z.object({
      message: EmailMessageSchema,
      instruction: z.string().min(1).default("A short, friendly nudge: two or three sentences."),
      daysWaiting: z.number().int().optional(),
      signature: z.string().max(500).optional(),
    }),
    output: z.object({ subject: z.string(), body: z.string(), language: z.string() }),
  },
  {
    type: "price.watch",
    description:
      "Checks the user's enabled Products of the pipeline's App (M33, pipelines/apps/prices.yaml): each shop line's page read " +
      "like shop.product, kept as an Offer with its price history (a removed line's Offer goes). `news`: a shop now at or under the user's target (once, when it crosses), the lowest in `lowestDays`, back in " +
      "stock; `text` says so with the cheapest shop for each (empty when nothing is new, for `when`). The addresses " +
      "are mine (a type of mine), so they need no allowedDomains. A dry run records nothing.",
    sideEffect: false,
    llm: true,
    saasSafe: true,
    reports: "report",
    entities: [OFFER_ENTITY, PRODUCT_ENTITY],
    input: z.object({
      product: z.string().min(1).max(200).optional().describe("only this product (its name); default: every enabled one"),
      lowestDays: z.number().int().min(7).max(365).default(90),
    }),
    output: z.object({
      products: Items,
      news: Items,
      text: z.string(),
      problems: z.array(z.string()),
      report: z.string(),
    }),
  },
  {
    type: "bill.read",
    description:
      "Reads bills out of `messages` (M23): for each email, its text and the text of its PDF attachments go to the " +
      "LLM, which says whether it is a bill (an amount the user has to pay) and reads issuer, amount, currency, due date, " +
      "period and reference. Emails that aren't bills are dropped. Nothing is paid or saved: bill.save keeps them.",
    sideEffect: false,
    llm: true,
    llmOutput: true,
    saasSafe: true,
    input: z.object({
      messages: Messages,
      mailbox: z.string().min(1).max(200).default("INBOX").describe("where the messages are, to read their PDFs"),
    }),
    output: z.object({
      bills: z.array(
        z.object({
          messageId: z.string(),
          from: z.string(),
          subject: z.string(),
          issuer: z.string(),
          amount: z.number(),
          currency: z.string(),
          dueDate: z.string().nullable().describe("YYYY-MM-DD"),
          period: z.string().nullable().describe("YYYY-MM"),
          reference: z.string().nullable(),
        }),
      ),
      notBills: z.number().int(),
    }),
  },
  {
    type: "bill.save",
    description:
      "Keeps bills from bill.read as Bill entities of the pipeline's App (M33; see pipelines/apps/bills.yaml): the same " +
      "bill again (same sender, reference or period) updates it, a new one is `due` until the user marks it paid. `added`: new bills; `remind`: the new ones with a due date, each with `remindAt` " +
      "(`remindDaysBefore` days before, 09:00) for calendar.create; `jumps`: new bills more than `jumpPercent` above " +
      "the usual (the median of the issuer's last six), and `jumpText` saying so (empty when none, for `when`).",
    sideEffect: false,
    saasSafe: true,
    entities: [BILL_ENTITY],
    input: z.object({
      bills: Items,
      remindDaysBefore: z.number().int().min(0).max(30).default(3),
      jumpPercent: z.number().int().min(5).max(500).default(30),
    }),
    output: z.object({
      added: Items,
      updated: Items,
      remind: Items,
      jumps: Items,
      jumpText: z.string(),
    }),
  },
  {
    type: "email.send",
    description:
      "Sends an email from the user's mailbox (SMTP); with `inReplyTo` (and the original's `references`) a reply in the same " +
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
    type: "calendar.find",
    description:
      "The user's Google Calendar's events between `from` and `to` (default: the next 7 days), optionally only those matching " +
      "`query` (title, description, location, guests): each with id, title, start, end, allDay, location, link, " +
      "meetLink, attendees, organizer. `none` is true when there are none (for when: a step only if the time is free).",
    sideEffect: false,
    saasSafe: true,
    input: z.object({
      from: DateTimeText.optional().describe("default: now"),
      to: DateTimeText.optional().describe("default: durationMinutes after from, else 7 days"),
      durationMinutes: z.number().int().min(1).max(1440).optional().describe("the window from `from`, e.g. 60: what an event then would clash with"),
      query: z.string().max(200).optional(),
      timeZone: TimeZone,
      maxResults: z.number().int().min(1).max(250).default(50),
    }),
    output: z.object({ events: Items, count: z.number().int(), none: z.boolean() }),
  },
  {
    type: "calendar.create",
    description:
      "Creates an event in the user's Google Calendar: `title`, `start`, `end` or `durationMinutes`, `timeZone` (for a time " +
      "without an offset), `description`, `location`, `meet` (a Google Meet link). With `attendees`, Google emails them " +
      "an invitation from the user's account (sendInvites). An event with the same title at the same start already there is " +
      "not created again (created: false, existing). Behind a gate like every side effect.",
    sideEffect: true,
    targets: { attendees: "recipient" },
    saasSafe: true,
    input: z.object({
      title: z.string().trim().min(1).max(300),
      start: DateTimeText,
      end: DateTimeText.optional(),
      durationMinutes: z.number().int().min(5).max(1440).default(60),
      timeZone: TimeZone,
      description: z.string().max(8000).optional(),
      location: z.string().max(500).optional(),
      attendees: z.array(z.email()).max(20).optional().describe("guests: each gets an invitation"),
      meet: z.boolean().default(false),
      sendInvites: z.boolean().default(true),
    }),
    output: z.object({
      created: z.boolean(),
      eventId: z.string(),
      link: z.string(),
      meetLink: z.string().nullable(),
      invited: z.array(z.string()),
    }),
  },
  {
    type: "flow.later",
    description:
      "Starts another pipeline (by name; its trigger must be { on: flow.later }) `after` a while (30m, 36h, 7d) or " +
      "`at` a time, with `data` as its {{trigger.data}}. Once, unless cancelled first: by flow.cancel with its `key`, " +
      "or by an event matching `cancelOn` (e.g. { event: application.status, match: { applicationId: … } }). " +
      "Another flow.later with the same key replaces it. A dry run schedules nothing.",
    sideEffect: false,
    saasSafe: true,
    input: z.object({
      pipeline: z.string().trim().min(1).max(100),
      after: z
        .string()
        .regex(/^\d{1,4}[mhd]$/, "a number and m, h or d, e.g. 7d")
        .optional(),
      at: DateTimeText.optional(),
      timeZone: TimeZone,
      data: z.record(z.string(), z.unknown()).default({}),
      key: z.string().trim().min(1).max(300).optional(),
      cancelOn: z
        .object({
          event: z.enum(["run.finished", "application.status", "recipe.broken", "email.classified"]),
          match: z.record(z.string().min(1), z.string()).describe("dotted paths in the event's data and the values that cancel"),
        })
        .optional(),
    }),
    output: z.object({ scheduledStartId: z.string().nullable(), fireAt: z.string(), replaced: z.number().int() }),
  },
  {
    type: "flow.cancel",
    description: "Cancels the pipeline starts flow.later scheduled with `key` and that haven't started yet.",
    sideEffect: false,
    saasSafe: true,
    input: z.object({ key: z.string().trim().min(1).max(300) }),
    output: z.object({ cancelled: z.number().int() }),
  },
  {
    type: "browser.open",
    description:
      "Opens a page in the browser and returns its text; can sign in with a stored credential first (kept signed in " +
      "between runs). Read-only: it submits nothing but the sign-in. Headed runs can be watched live, and the user takes over " +
      "when it meets a CAPTCHA, a 2FA prompt or a page it doesn't recognize.",
    sideEffect: false,
    acceptsCredentials: true,
    headed: "input",
    saasSafe: false,
    input: z.object({
      url: z.url({ protocol: /^https?$/ }),
      /** The watchable browser (live view): for sign-ins and anything the user may have to take over. */
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
      waitFor: Selector.optional().describe("the page is ready when this appears; if it doesn't, the user takes over"),
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
      "with `fallback`, browser.agent finds the list instead and a fixed recipe is proposed for the user to approve, read with now.",
    sideEffect: false,
    saasSafe: false,
    input: z.object({
      recipes: z.array(RecipeNameSchema).min(1).max(5).describe('saved recipes, e.g. ["jobs.example.com/search"]'),
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
      "Teach mode: opens `url` in the live browser; the user brings it to the list to read and press Continue; the LLM " +
      "proposes a recipe from the page, it is checked on the page (items outlined), and Continue saves it as the next " +
      "version of `recipe`. Used once per site, not in scheduled pipelines.",
    sideEffect: false,
    llm: true,
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
    entities: [JOB_ENTITY],
    description:
      "Opens an application form (following the page's Apply button when the form isn't there) and reads every field, " +
      "typing and attaching nothing. Proposes each value from the user's profile (Settings) and writes free-text answers " +
      "following `message`; attaches the stored document `cv` to the CV field. Its output is the payload for " +
      "browser.fillAndSubmit, which the user sees and edits at the gate.",
    sideEffect: false,
    llm: true,
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
    entities: [JOB_ENTITY],
    description:
      "Fills an application form with exactly the approved fields and files and submits it, in the live browser. " +
      "Before typing it reads the form again: a field that changed, a new required field or another address pauses " +
      "the run for the user, and nothing is submitted. With stopBeforeSubmit it fills everything and the user presses " +
      "the final button.",
    sideEffect: true,
    targets: { url: "domain" },
    headed: true,
    saasSafe: false,
    input: z.object({
      url: z.url({ protocol: /^https?$/ }),
      fields: z.array(FormFieldSchema),
      files: z.array(FormFileSchema).default([]),
      stopBeforeSubmit: z.boolean().default(false).describe("fill, then the user submits in the live view"),
      job: z.string().optional().describe("the posting's url: its Application is marked submitted"),
      timeoutSeconds: z.number().int().min(5).max(120).default(30),
    }),
    output: z.object({
      submitted: z.boolean().describe("the form was sent (by the step, or by the user when stopBeforeSubmit)"),
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
      "Puts one of the user's stored documents (`file`, from file.read) into the file field `field` on `url`, and presses " +
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
      "Reads the text of one of the user's stored documents (`document`, e.g. cv-main) or of a file browser.download " +
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
      "Its recorded actions and final button are the payload of browser.submit, which the user sees at the gate.",
    sideEffect: false,
    llm: true,
    llmOutput: true,
    pageFields: ["url"],
    headed: "input",
    saasSafe: false,
    input: z.object({
      url: z.url({ protocol: /^https?$/ }),
      goal: z.string().min(1).max(2000).describe("what to do, e.g. find the application form and fill it from the user's profile"),
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
      "button. An element that is no longer there, or a page off the allowed sites, pauses the run for the user with " +
      "nothing sent. With stopBeforeSubmit the user presses the final button.",
    sideEffect: true,
    targets: { url: "domain" },
    headed: true,
    saasSafe: false,
    input: z.object({
      url: z.url({ protocol: /^https?$/ }),
      actions: z.array(AgentActionSchema).max(100),
      files: z.array(FormFileSchema).default([]),
      submit: ElementTargetSchema,
      stopBeforeSubmit: z.boolean().default(false).describe("fill, then the user submits in the live view"),
      job: z.string().optional().describe("the posting's url: its Application is marked submitted"),
      timeoutSeconds: z.number().int().min(5).max(120).default(30),
    }),
    output: z.object({
      submitted: z.boolean().describe("the form was sent (by the step, or by the user when stopBeforeSubmit)"),
      url: z.string(),
      confirmation: z.string().describe("the page's text after sending"),
    }),
  },
];

export const defaultCatalog = (): StepCatalog => new StepCatalog(CORE_STEPS);

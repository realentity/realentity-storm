import { z } from "zod";

/** Topics (M41, docs/design.md §8.1): subjects Storm keeps a memory of, and the directions that say what belongs to one. */

export const TOPIC_STATUSES = ["ACTIVE", "ARCHIVED"] as const;
export type TopicStatusName = (typeof TOPIC_STATUSES)[number];

export const TOPIC_DIRECTION_KINDS = ["WORD", "DOMAIN", "PERSON", "TEXT"] as const;
export type TopicDirectionKindName = (typeof TOPIC_DIRECTION_KINDS)[number];

export interface TopicDirectionView {
  topicDirectionId: string;
  kind: TopicDirectionKindName;
  value: string;
  about: string | null;
  dateCreated: string;
}

export interface TopicView {
  topicId: string;
  name: string;
  description: string;
  status: TopicStatusName;
  directions: TopicDirectionView[];
  /** What its upkeep and backfills cost in the last 30 days (M44-T5): shared out from the topic steps. */
  costUsd30: number;
  dateCreated: string;
  dateUpdated: string;
}

export const TopicSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(2000).default(""),
  })
  .strict();
export type TopicRequest = z.input<typeof TopicSchema>;

export const TopicUpdateSchema = TopicSchema.extend({ status: z.enum(TOPIC_STATUSES) }).strict();
export type TopicUpdateRequest = z.input<typeof TopicUpdateSchema>;

const DOMAIN = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
// The domain's labels hold no dot, so the pattern has one way to match (no slow backtracking on odd input).
const ADDRESS = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/**
 * A direction as stored: a domain and an address lowercase (a domain without "@" or "*."), `about` only for a person.
 * Returns why it can't be one instead.
 */
export function normalizeDirection(input: {
  kind: TopicDirectionKindName;
  value: string;
  about?: string | null;
}): { kind: TopicDirectionKindName; value: string; about: string | null } | { error: string } {
  const value = input.value.trim().replace(/\s+/g, " ");
  const about = input.about?.trim() || null;
  if (about && input.kind !== "PERSON") return { error: "Only a person's direction says what about" };
  if (about && about.length > 200) return { error: "What about: at most 200 characters" };
  switch (input.kind) {
    case "WORD":
      if (value.length < 2 || value.length > 100) return { error: "A word or name of 2 to 100 characters" };
      return { kind: "WORD", value, about: null };
    case "DOMAIN": {
      const domain = value.toLowerCase().replace(/^(\*\.|@)/, "");
      if (!DOMAIN.test(domain)) return { error: "Not a domain (like client.example)" };
      return { kind: "DOMAIN", value: domain, about: null };
    }
    case "PERSON": {
      const address = value.toLowerCase();
      if (address.length > 254 || !ADDRESS.test(address)) return { error: "Not an email address" };
      return { kind: "PERSON", value: address, about };
    }
    case "TEXT":
      if (value.length < 3 || value.length > 500) return { error: "Plain words of 3 to 500 characters" };
      return { kind: "TEXT", value, about: null };
  }
}

export const TopicDirectionSchema = z
  .object({
    kind: z.enum(TOPIC_DIRECTION_KINDS),
    value: z.string().max(500),
    about: z.string().max(500).nullish(),
  })
  .strict()
  .transform((direction, ctx) => {
    const normalized = normalizeDirection(direction);
    if ("error" in normalized) {
      ctx.addIssue({ code: "custom", message: normalized.error, path: ["value"] });
      return z.NEVER;
    }
    return normalized;
  });
export type TopicDirectionRequest = z.input<typeof TopicDirectionSchema>;

export const TOPIC_LINK_STATUSES = ["LINKED", "SUGGESTED", "CONFIRMED", "REJECTED"] as const;
export type TopicLinkStatusName = (typeof TOPIC_LINK_STATUSES)[number];

/** An email and a topic it belongs to (M41-T3): what Storm keeps of the email is its ids, sender, subject and date. */
export interface TopicLinkView {
  topicLinkId: string;
  topicId: string;
  topicName: string;
  messageId: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
  status: TopicLinkStatusName;
  via: "DIRECTION" | "THREAD" | "LLM" | "USER";
  evidence: string;
  dateCreated: string;
}

/** Moving an email's link to another topic (M41-T4): the old one rejected, the new one confirmed. */
export const MoveTopicLinkSchema = z.object({ topicId: z.string().uuid() }).strict();
export type MoveTopicLinkRequest = z.input<typeof MoveTopicLinkSchema>;

export const TOPIC_FACT_STATUSES = ["CURRENT", "SUPERSEDED", "DISPUTED", "WRONG"] as const;
export type TopicFactStatusName = (typeof TOPIC_FACT_STATUSES)[number];

export const TOPIC_CHANGE_KINDS = ["ADD", "EDIT", "NO_LONGER_TRUE", "WRONG", "MOVE", "SETTLE", "APPLY", "SPLIT", "MERGE"] as const;
export type TopicChangeKindName = (typeof TOPIC_CHANGE_KINDS)[number];

/** What is true about a topic (M42-T1, docs/design.md §8.1), with its source and that source's date. */
export interface TopicFactView {
  topicFactId: string;
  topicId: string;
  about: string;
  statement: string;
  source: "EMAIL" | "USER" | "FILE";
  sourceId: string | null;
  sourceLabel: string;
  sourceDate: string;
  quote: string;
  status: TopicFactStatusName;
  supersededById: string | null;
  pinned: boolean;
  dateUpdated: string;
}

/** A change to a topic's facts (M42-T1): what and when, and whether it can still be undone. */
export interface TopicChangeView {
  topicChangeId: string;
  topicId: string;
  otherTopicId: string | null;
  kind: TopicChangeKindName;
  summary: string;
  byRun: boolean;
  undone: boolean;
  dateCreated: string;
}

/** A fact the user writes or edits: what it is about ("Launch date") and what is true ("March 2027"). */
export const TopicFactSchema = z
  .object({
    about: z.string().trim().min(1).max(120),
    statement: z.string().trim().min(1).max(1000),
  })
  .strict()
  .superRefine((fact, ctx) => {
    if (looksSecret(`${fact.about} ${fact.statement}`)) {
      ctx.addIssue({ code: "custom", message: "That looks like a secret: keep it as a credential instead", path: ["statement"] });
    }
  });
export type TopicFactRequest = z.input<typeof TopicFactSchema>;

/** "No longer true", optionally with what is true now (the old fact superseded by it). */
export const TopicFactNoLongerTrueSchema = z
  .object({ statement: z.string().trim().min(1).max(1000).optional() })
  .strict()
  .superRefine((body, ctx) => {
    if (body.statement && looksSecret(body.statement)) {
      ctx.addIssue({ code: "custom", message: "That looks like a secret: keep it as a credential instead", path: ["statement"] });
    }
  });
export type TopicFactNoLongerTrueRequest = z.input<typeof TopicFactNoLongerTrueSchema>;

export const MoveTopicFactSchema = z.object({ topicId: z.string().uuid() }).strict();
export type MoveTopicFactRequest = z.input<typeof MoveTopicFactSchema>;

// A secret's name followed by its value: "password: x", "the API key is x", "парола = x".
const SECRET_WORD =
  /(?<![\p{L}\p{N}])(password|passwd|pwd|passcode|passphrase|pin|api[ _-]?key|access[ _-]?key|secret|token|private[ _-]?key|passwort|kennwort|mot de passe|contraseña|wachtwoord|парола|пин)(?![\p{L}\p{N}])\s*(:|=|is\s|was\s|е\s)\s*\S/iu;
const SECRET_SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
];

/**
 * Whether a text looks like it holds a secret (a password, a key, a token): never proposed as a topic's fact
 * (docs/design.md §8.1, Safety). Errs on the side of yes: such a fact is left out, not kept.
 */
export function looksSecret(text: string): boolean {
  if (SECRET_WORD.test(text) || SECRET_SHAPES.some((shape) => shape.test(text))) return true;
  // A long run of letters and digits mixed, like a key: not a word, a date, an amount or a link.
  const withoutLinks = text.replace(/https?:\/\/\S+/g, " ");
  return (withoutLinks.match(/[A-Za-z0-9_+/=-]{32,}/g) ?? []).some((run) => /[A-Za-z]/.test(run) && /[0-9]/.test(run));
}

/**
 * Topic upkeep (M42): the pipeline that keeps topics' memory up to date from email (pipelines/topic-upkeep.yaml, or any
 * of the user's with topic.extract), and what it still needs, for the card on the Topics page.
 */
export interface TopicUpkeepView {
  pipeline: { pipelineId: string; name: string; enabled: boolean } | null;
  /** It has run at least once, a dry run included. */
  tried: boolean;
  lastRun: { runId: string; status: string; dryRun: boolean; finishedAt: string | null } | null;
  /** Fact proposals of its runs waiting at a gate. */
  waiting: number;
  email: boolean;
  emailProblem: string | null;
  llm: boolean;
  /** Active topics with at least one direction: without one, no email is linked. */
  topicsWithDirections: number;
}

export const TOPIC_SOURCE_KINDS = ["GITHUB", "DRIVE"] as const;
export type TopicSourceKindName = (typeof TOPIC_SOURCE_KINDS)[number];

/** Where a topic's documents live (M43, docs/design.md §8.1): linked, never copied; its passages are a cache. */
export interface TopicSourceView {
  topicSourceId: string;
  topicId: string;
  /** ATTACHMENT: an email's attachment, added by topic.attachments (location: the email's Message-ID). */
  kind: TopicSourceKindName | "ATTACHMENT";
  /** ATTACHMENT: its email, "Maria <maria@client.example>: Kickoff". */
  title: string;
  /** GITHUB: owner/repo. DRIVE: the folder's id (its name is `title`, once read). */
  location: string;
  branch: string | null;
  path: string;
  credential: string | null;
  /** The last commit indexed, short; null until it is read. */
  cursor: string | null;
  readAt: string | null;
  passages: number;
  /** Where to open it: the repository's files under the path, the Drive folder; "" for an attachment. */
  url: string;
}

const REPOSITORY = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
/** A Drive file or folder id: letters, digits, "-" and "_". */
const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;

/**
 * A Drive folder's id from what the user pastes: its link (drive.google.com/drive/folders/<id>, also under /u/0/, with
 * ?usp=…) or the id itself; null when it is neither.
 */
export function driveFolderId(value: string): string | null {
  const text = value.trim();
  const link = /^https:\/\/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?folders\/|open\?id=)([A-Za-z0-9_-]+)/i.exec(text);
  const id = link?.[1] ?? text;
  return DRIVE_ID.test(id) ? id : null;
}
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;
const GLOB = /^[A-Za-z0-9._/*?{},@ -]{1,300}$/;

export const TopicSourceSchema = z
  .object({
    kind: z.enum(TOPIC_SOURCE_KINDS),
    location: z.string().trim().max(500),
    branch: z
      .string()
      .trim()
      .transform((value) => value || null)
      .refine((value) => value === null || BRANCH.test(value), "Not a branch name")
      .nullish(),
    path: z
      .string()
      .trim()
      .transform((value) => value.replace(/^\/+/, "") || "**")
      .refine((value) => GLOB.test(value) && !value.split("/").includes(".."), "A path like docs/adr/** or **/*.md")
      .default("**"),
    credential: z
      .string()
      .trim()
      .transform((value) => value || null)
      .nullish(),
  })
  .strict()
  .transform((source, context) => {
    if (source.kind === "DRIVE") {
      // A folder: its link or id. No branch, and no credential: Drive is read through the Google connection.
      const folder = driveFolderId(source.location);
      if (!folder) context.addIssue({ code: "custom", path: ["location"], message: "A Google Drive folder: its link or id" });
      return { ...source, location: folder ?? source.location, branch: null, credential: null };
    }
    const repo = source.location.replace(/^https:\/\/github\.com\//i, "").replace(/\.git$|\/$/g, "");
    if (!REPOSITORY.test(repo)) context.addIssue({ code: "custom", path: ["location"], message: "A GitHub repository: owner/repo" });
    return { ...source, location: repo };
  });
export type TopicSourceRequest = z.input<typeof TopicSourceSchema>;

/** "docs/adr///" → "docs/adr", by a loop: a regular expression for it is slow on long runs of "/". */
function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === "/") end--;
  return path.slice(0, end);
}

/**
 * Whether a file's path is under a source's pattern: `**` any folders, `*` any characters but "/", `?` one, `{a,b}`
 * either. A pattern without a wildcard is a folder or a file: "docs/adr" holds docs/adr/0001.md.
 */
export function pathMatches(pattern: string, path: string): boolean {
  const glob = /[*?{]/.test(pattern) ? pattern : `${withoutTrailingSlashes(pattern)}{,/**}`;
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // "**/" matches no folder too.
      if (glob[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else if (c === "{") source += "(?:";
    else if (c === "}") source += ")";
    else if (c === "," && glob.lastIndexOf("{", i) > glob.lastIndexOf("}", i)) source += "|";
    else source += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`).test(path);
}

/** The files a source indexes: text, by their extension. */
export function isTextFile(path: string): boolean {
  return /\.(md|markdown|mdx|txt|text|adoc|asciidoc|rst|org)$/i.test(path);
}

/** A draft's topic memory, at most (M42-T3): the topics' descriptions and current facts, in characters. */
export const MEMORY_TEXT = 6_000;
/** Of which a topic's description, at most (M44-T7): the facts matter more. */
export const DESCRIPTION_TEXT = 1_000;

/** A fact as a draft's <memory> lists it (M42-T3), after its reference ("- F3: "). */
export function memoryLine(fact: {
  about: string;
  statement: string;
  source: string;
  sourceLabel: string;
  sourceDate: Date | string;
}): string {
  const date = new Date(fact.sourceDate).toISOString().slice(0, 10);
  return `${fact.about}: ${fact.statement} (${fact.source === "USER" ? "the user" : fact.sourceLabel}, ${date})`;
}

/** "- F12: " and the line's end. */
const REF_LENGTH = 8;

/**
 * How many of a topic's current facts fit in a draft at most (M44-T7), after its description. When not all of them do,
 * a draft takes the pinned ones first, then those closest to its email.
 */
export function factsThatFit(description: string, facts: Parameters<typeof memoryLine>[0][]): number {
  let room = MEMORY_TEXT - Math.min(description.length, DESCRIPTION_TEXT);
  let fit = 0;
  for (const fact of [...facts].sort((a, b) => memoryLine(a).length - memoryLine(b).length)) {
    const length = memoryLine(fact).length + REF_LENGTH;
    if (length > room) break;
    room -= length;
    fit++;
  }
  return fit;
}

/** The words a fact or an email is matched by (M44-T7): letters and digits, four or more, lowercase. */
export function matchWords(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
}

export const TOPIC_BACKFILL_STATUSES = [
  "ESTIMATING",
  "ESTIMATED",
  "SCREENING",
  "PROPOSING",
  "REVIEW",
  "DONE",
  "FAILED",
  "CANCELLED",
] as const;
export type TopicBackfillStatusName = (typeof TOPIC_BACKFILL_STATUSES)[number];

/**
 * Reading a topic's history for facts (M43-T5): what was found and what reading it costs, then the proposals for the
 * user to pick.
 */
export interface TopicBackfillView {
  topicBackfillId: string;
  topicId: string;
  months: number;
  documents: boolean;
  status: TopicBackfillStatusName;
  /** Past emails found (by the topic's exact directions and their threads). */
  emails: number;
  /** Documents of its sources, from the index. */
  files: number;
  estimateUsd: number | null;
  /** What it cost so far. */
  costUsd: number | null;
  /** REVIEW: the proposals, in order; picked by their place. */
  proposals: { title: string; quote: string; kind: string }[];
  applied: number;
  error: string | null;
  dateCreated: string;
  finishedAt: string | null;
}

/** How far back a backfill reads: up to two years. */
export const TopicBackfillSchema = z
  .object({
    months: z.number().int().min(1).max(24),
    documents: z.boolean().default(true),
  })
  .strict();
export type TopicBackfillRequest = z.input<typeof TopicBackfillSchema>;

export const ApplyTopicBackfillSchema = z.object({ picked: z.array(z.number().int().min(0)).max(1000) }).strict();
export type ApplyTopicBackfillRequest = z.input<typeof ApplyTopicBackfillSchema>;

/** What Storm suggests for topics (M44): a direction, a topic, a fact; nothing is active before the user accepts it. */
export interface TopicSuggestionView {
  topicSuggestionId: string;
  topicId: string | null;
  topicName: string | null;
  kind: "DIRECTION" | "TOPIC" | "FACT";
  /** DIRECTION: { kind, value, about }; TOPIC: { name, description, directions }; FACT: a proposal ({ title, quote, ... }). */
  payload: Record<string, unknown>;
  reason: string;
  status: "OPEN" | "ACCEPTED" | "DISMISSED";
  dateCreated: string;
}

/** Free mail providers: a domain direction there would take in everyone. */
const FREE_MAIL = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "web.de",
  "yandex.com",
  "yandex.ru",
  "mail.ru",
  "abv.bg",
  "mail.bg",
  "dir.bg",
  "zoho.com",
  "fastmail.com",
  "hey.com",
];

/** Whether a domain is a free mail provider's (or one of its country domains, like yahoo.co.uk). */
export function isFreeMailDomain(domain: string): boolean {
  const d = domain.toLowerCase();
  return FREE_MAIL.includes(d) || /^(yahoo|hotmail|outlook|live|gmx|yandex)\.[a-z.]{2,6}$/.test(d);
}

/** Split (M44-T4): what moves to the new topic, by id; at least one thing. */
export const SplitTopicSchema = TopicSchema.extend({
  facts: z.array(z.string().uuid()).max(1000).default([]),
  directions: z.array(z.string().uuid()).max(200).default([]),
  sources: z.array(z.string().uuid()).max(200).default([]),
  links: z.array(z.string().uuid()).max(1000).default([]),
}).strict();
export type SplitTopicRequest = z.input<typeof SplitTopicSchema>;

/** Merge (M44-T4): this topic into another. */
export const MergeTopicSchema = z.object({ into: z.string().uuid() }).strict();
export type MergeTopicRequest = z.input<typeof MergeTopicSchema>;

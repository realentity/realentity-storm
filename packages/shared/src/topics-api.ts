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
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
      if (!ADDRESS.test(address)) return { error: "Not an email address" };
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

export const TOPIC_CHANGE_KINDS = ["ADD", "EDIT", "NO_LONGER_TRUE", "WRONG", "MOVE", "SETTLE", "APPLY"] as const;
export type TopicChangeKindName = (typeof TOPIC_CHANGE_KINDS)[number];

/** What is true about a topic (M42-T1, docs/design.md §8.1), with its source and that source's date. */
export interface TopicFactView {
  topicFactId: string;
  topicId: string;
  about: string;
  statement: string;
  source: "EMAIL" | "USER";
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

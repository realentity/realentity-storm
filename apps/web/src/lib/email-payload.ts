/** The steps whose payload is an email: their gate shows it as one (To, Subject, the message, the thread folded away). */
export const EMAIL_STEPS: ReadonlySet<string> = new Set(["email.send"]);

const HEADERS = ["to", "subject"] as const;
const THREAD = ["inReplyTo", "references"] as const;

export const EMAIL_LABELS: Record<string, string> = {
  to: "To",
  subject: "Subject",
  body: "Message",
  inReplyTo: "In reply to",
  references: "Earlier in the thread",
};

export interface EmailFields {
  /** To and Subject, in that order, those the payload has. */
  headers: string[];
  /** The message, when the payload has one. */
  body: string | null;
  /** In-Reply-To and References: only threading, so folded away. */
  thread: string[];
  /** Anything else the step was given, shown after the message. */
  other: string[];
}

/** Sorts an email payload's fields into the parts of an email, whatever order the pipeline wrote them in. */
export function emailFields(payload: Record<string, unknown>): EmailFields {
  const fields = Object.keys(payload);
  const known = new Set<string>([...HEADERS, "body", ...THREAD]);
  return {
    headers: HEADERS.filter((field) => fields.includes(field)),
    body: fields.includes("body") ? "body" : null,
    thread: THREAD.filter((field) => fields.includes(field) && !isEmpty(payload[field])),
    other: fields.filter((field) => !known.has(field)),
  };
}

/** How many earlier messages the reply continues: In-Reply-To and References name the same one, so they are counted once. */
export function threadLength(payload: Record<string, unknown>): number {
  const ids = new Set<string>();
  if (typeof payload.inReplyTo === "string" && payload.inReplyTo) ids.add(payload.inReplyTo);
  if (Array.isArray(payload.references)) for (const id of payload.references) if (typeof id === "string" && id) ids.add(id);
  return ids.size;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

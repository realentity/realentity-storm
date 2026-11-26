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
  /** M59-T1: the files it attaches (an App's), shown by name and size, not edited. */
  attachments: AttachedFile[];
  /** In-Reply-To and References: only threading, so folded away. */
  thread: string[];
  /** Anything else the step was given, shown after the message. */
  other: string[];
}

/** Sorts an email payload's fields into the parts of an email, whatever order the pipeline wrote them in. */
export function emailFields(payload: Record<string, unknown>): EmailFields {
  const fields = Object.keys(payload);
  // `account` is whom it goes from: shown resolved, as From (ProposalView.from), and not edited here.
  const known = new Set<string>([...HEADERS, "body", ...THREAD, "account", "attachments"]);
  return {
    headers: HEADERS.filter((field) => fields.includes(field)),
    body: fields.includes("body") ? "body" : null,
    attachments: attachedFiles(payload.attachments),
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

export interface AttachedFile {
  name: string;
  mime: string;
  size: number;
}

/** An email's attachments as its payload has them: an App's files ({ id, name, mime, size }). */
export function attachedFiles(value: unknown): AttachedFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((file: unknown) => {
    const { name, mime, size } = (file ?? {}) as Record<string, unknown>;
    return typeof name === "string" && typeof size === "number" ? [{ name, mime: typeof mime === "string" ? mime : "", size }] : [];
  });
}

/** A file's size as people read it: 820 B, 14 KB, 2.3 MB. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

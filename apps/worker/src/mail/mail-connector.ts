import { type EmailMessage } from "@realentity/storm-steps";

/** Where a pipeline stopped reading a mailbox (MailCursor). */
export interface MailboxPosition {
  uidValidity: bigint;
  lastUid: number;
}

export interface FetchRequest {
  mailbox: string;
  /** null: the first read (or the server renumbered the mailbox): look back to `since`. */
  after: MailboxPosition | null;
  since: Date;
  /** The oldest `limit` new messages; the rest come next time. */
  limit: number;
}

export interface FetchResult {
  messages: EmailMessage[];
  /** Where the next read continues. */
  position: MailboxPosition;
}

/** A mailbox's messages since a date, without a cursor (M22): the newest `limit`, oldest first. */
export interface RecentRequest {
  /** SENT_MAILBOX: the server's Sent folder. */
  mailbox: string;
  since: Date;
  limit: number;
}

/** An attachment's bytes (M23: a bill's PDF). */
export interface MailAttachment {
  filename: string | null;
  contentType: string;
  content: Buffer;
}

export const SENT_MAILBOX = "\\Sent";

/** An earlier message of a thread (M41-T1); `mine`: the user wrote it (it is from the mailbox's own address). */
export interface ThreadMessage {
  message: EmailMessage;
  mine: boolean;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string[];
}

export interface SentMail {
  messageId: string;
  accepted: string[];
}

/**
 * A mailbox (docs/design.md §4): v1 is IMAP + SMTP with an app password; the Gmail API can replace it behind this interface.
 * Reading never changes the mailbox (nothing is marked read or moved).
 */
export interface MailConnector {
  fetch(userId: string, request: FetchRequest): Promise<FetchResult>;
  recent(userId: string, request: RecentRequest): Promise<EmailMessage[]>;
  /** One message's attachments, read-only; the message whole up to `maxBytes`. */
  attachments(userId: string, request: { mailbox: string; uid: number; maxBytes: number }): Promise<MailAttachment[]>;
  /**
   * The messages with these Message-IDs (an email's References and In-Reply-To), read-only, oldest first: in All Mail
   * where the server has it (Gmail), else in INBOX and the Sent folder. Ones no longer there are left out.
   */
  thread(userId: string, messageIds: string[]): Promise<ThreadMessage[]>;
  send(userId: string, mail: OutgoingMail): Promise<SentMail>;
}

/** Text the LLM gets per email: enough to triage and reply, bounded for cost. */
export const MAX_TEXT_LENGTH = 20_000;

/** The thread an email belongs to: the first of References, else In-Reply-To, else itself. */
export function threadIdOf(messageId: string, inReplyTo: string | null, references: string[]): string {
  return references[0] ?? inReplyTo ?? messageId;
}

/** Message-IDs from a References / In-Reply-To value: "<a@x> <b@y>" or a list of them. */
export function messageIds(value: string | string[] | undefined): string[] {
  const text = Array.isArray(value) ? value.join(" ") : (value ?? "");
  return [...text.matchAll(/<[^<>\s]+>/g)].map((m) => m[0]);
}

/** Collapses whitespace runs and cuts the text at the limit (marking the cut). */
export function boundedText(text: string): string {
  const cleaned = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > MAX_TEXT_LENGTH ? `${cleaned.slice(0, MAX_TEXT_LENGTH)}\n[… cut at ${MAX_TEXT_LENGTH} characters]` : cleaned;
}

/** Removes a secret from a message (error texts from mail libraries), so it can't reach logs or Step rows. */
export function withoutSecret(message: string, secret: string): string {
  return secret ? message.split(secret).join("[secret]") : message;
}

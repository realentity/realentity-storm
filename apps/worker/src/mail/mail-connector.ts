import { type EmailMessage } from "@realentity/storm-steps";

/**
 * M50-T7: whose mailbox: one of the user's email accounts by id (a step's `account` slot, or the account a message came
 * from), else their default one.
 */
export interface MailWho {
  userId: string;
  account?: string | null;
}

/** M50-T16: `account: topics` on email.fetch: every mailbox the user's topics read. */
export const TOPICS_ACCOUNT = "topics";

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whose mailbox a step reads or sends from: `account` is an email slot's name (filled on the pipeline or its App) or an
 * account's id (a message's `account`); a slot not filled, or none given, is the default account.
 */
export function mailWho(context: { userId: string; emailAccounts?: Readonly<Record<string, string>> }, account?: string | null): MailWho {
  if (!account) return { userId: context.userId };
  if (ACCOUNT_ID.test(account)) return { userId: context.userId, account };
  return { userId: context.userId, account: context.emailAccounts?.[account] ?? null };
}

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
  /** The account read (its id): a cursor is per account. */
  account: string;
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
  /** The address it went from. */
  from: string;
}

/**
 * A mailbox (docs/design.md §4): v1 is IMAP + SMTP with an app password; the Gmail API can replace it behind this interface.
 * Reading never changes the mailbox (nothing is marked read or moved). Every message read carries its `account`.
 */
export interface MailConnector {
  fetch(who: MailWho, request: FetchRequest): Promise<FetchResult>;
  recent(who: MailWho, request: RecentRequest): Promise<EmailMessage[]>;
  /** One message's attachments, read-only; the message whole up to `maxBytes`. */
  attachments(who: MailWho, request: { mailbox: string; uid: number; maxBytes: number }): Promise<MailAttachment[]>;
  /**
   * The messages with these Message-IDs (an email's References and In-Reply-To), read-only, oldest first: in All Mail
   * where the server has it (Gmail), else in INBOX and the Sent folder. Ones no longer there are left out.
   */
  thread(who: MailWho, messageIds: string[]): Promise<ThreadMessage[]>;
  send(who: MailWho, mail: OutgoingMail): Promise<SentMail>;
}

/** No email account to read or send with. */
export class NoEmailAccountError extends Error {
  constructor(account?: string | null) {
    super(
      account
        ? "That email account is no longer yours (removed?): choose another"
        : "No email account yet: add one in Settings → Email accounts",
    );
    this.name = "NoEmailAccountError";
  }
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

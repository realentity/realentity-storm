import { type EmailMessage } from "@realentity/storm-steps";
import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import { createTransport } from "nodemailer";
import { type CredentialVault } from "../secrets/credential-vault";
import {
  boundedText,
  messageIds,
  threadIdOf,
  withoutSecret,
  type FetchRequest,
  type FetchResult,
  type MailAttachment,
  type MailConnector,
  type OutgoingMail,
  type RecentRequest,
  type SentMail,
  SENT_MAILBOX,
} from "./mail-connector";

export interface MailServerConfig {
  imapHost?: string;
  imapPort: number;
  smtpHost?: string;
  smtpPort: number;
  /** TLS from the first byte (993/465); off only for a local test server (checked in the environment schema). */
  tls: boolean;
  /** The credential with the address (username) and the app password. */
  credential: string;
}

/** Text is parsed from at most this much of a message; attachments are listed from BODYSTRUCTURE, never downloaded. */
const SOURCE_LIMIT = 2_000_000;
const TIMEOUT_MS = 30_000;

/**
 * IMAP (imapflow) and SMTP (nodemailer) with an app password (docs/design.md §4). The password is decrypted per operation,
 * only for the configured server's host (the credential's allowedHosts), and never appears in errors.
 */
export class ImapSmtpConnector implements MailConnector {
  constructor(
    private readonly config: MailServerConfig,
    private readonly vault: CredentialVault,
  ) {}

  async recent(userId: string, request: RecentRequest): Promise<EmailMessage[]> {
    return this.imap(userId, async (client) => {
      const name = request.mailbox === SENT_MAILBOX ? await sentMailbox(client) : request.mailbox;
      const lock = await client.getMailboxLock(name, { readOnly: true });
      try {
        const found = (await client.search({ since: request.since }, { uid: true })) || [];
        return await fetchMessages(client, found.sort((a, b) => a - b).slice(-request.limit));
      } finally {
        lock.release();
      }
    });
  }

  async attachments(userId: string, request: { mailbox: string; uid: number; maxBytes: number }): Promise<MailAttachment[]> {
    return this.imap(userId, async (client) => {
      const lock = await client.getMailboxLock(request.mailbox, { readOnly: true });
      try {
        const fetched = await client.fetchOne(String(request.uid), { source: { maxLength: request.maxBytes } }, { uid: true });
        if (!fetched || !fetched.source) throw new Error(`No message ${request.uid} in ${request.mailbox}`);
        const parsed = await simpleParser(fetched.source, { skipImageLinks: true, skipTextToHtml: true });
        return parsed.attachments.map((a) => ({ filename: a.filename ?? null, contentType: a.contentType, content: a.content }));
      } finally {
        lock.release();
      }
    });
  }

  /** A read-only IMAP session; errors without the password. */
  private async imap<T>(userId: string, work: (client: ImapFlow) => Promise<T>): Promise<T> {
    const host = this.config.imapHost;
    if (!host) throw new Error("Mail is not configured (IMAP_HOST)");
    const login = await this.login(userId, host);
    const client = new ImapFlow({
      host,
      port: this.config.imapPort,
      secure: this.config.tls,
      auth: { user: login.user, pass: login.pass },
      logger: false,
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: 5 * TIMEOUT_MS,
    });
    try {
      await client.connect();
      return await work(client);
    } catch (error) {
      throw new Error(`IMAP: ${withoutSecret(message(error), login.pass)}`);
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  async fetch(userId: string, request: FetchRequest): Promise<FetchResult> {
    return this.imap(userId, async (client) => {
      // Read-only: EXAMINE, so even fetching a body doesn't set \Seen.
      const lock = await client.getMailboxLock(request.mailbox, { readOnly: true });
      try {
        const mailbox = client.mailbox;
        if (!mailbox) throw new Error(`Mailbox "${request.mailbox}" could not be opened`);
        const continues = request.after !== null && request.after.uidValidity === mailbox.uidValidity;
        const found = continues
          ? await client.search({ uid: `${request.after!.lastUid + 1}:*` }, { uid: true })
          : await client.search({ since: request.since }, { uid: true });
        // "n:*" also matches the last message when it is below n.
        const floor = continues ? request.after!.lastUid : 0;
        const uids = (found || [])
          .filter((uid) => uid > floor)
          .sort((a, b) => a - b)
          .slice(0, request.limit);
        const messages = await fetchMessages(client, uids);
        // Next time: after the last message returned, or (nothing new) after everything the mailbox has now.
        const lastUid = uids.length > 0 ? uids[uids.length - 1] : Math.max(floor, mailbox.uidNext - 1);
        return { messages, position: { uidValidity: mailbox.uidValidity, lastUid } };
      } finally {
        lock.release();
      }
    });
  }

  async send(userId: string, mail: OutgoingMail): Promise<SentMail> {
    const host = this.config.smtpHost;
    if (!host) throw new Error("Mail is not configured (SMTP_HOST)");
    const login = await this.login(userId, host);
    // A reply to the user's own address answers mail they sent themselves (Storm's own messages): never sent.
    if (mail.inReplyTo && mail.to.trim().toLowerCase() === login.user.trim().toLowerCase()) {
      throw new Error("Not sent: a reply to your own address (mail you sent yourself)");
    }
    const transport = createTransport({
      host,
      port: this.config.smtpPort,
      secure: this.config.tls,
      auth: { user: login.user, pass: login.pass },
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: 2 * TIMEOUT_MS,
    });
    try {
      const info = await transport.sendMail({
        from: login.user,
        to: mail.to,
        subject: mail.subject,
        text: mail.body,
        ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
        ...(mail.references?.length ? { references: mail.references } : {}),
      });
      const accepted = (info.accepted as (string | { address: string })[]).map((a) => (typeof a === "string" ? a : a.address));
      return { messageId: String(info.messageId), accepted };
    } catch (error) {
      throw new Error(`SMTP: ${withoutSecret(message(error), login.pass)}`);
    } finally {
      transport.close();
    }
  }

  private async login(userId: string, host: string): Promise<{ user: string; pass: string }> {
    const credential = await this.vault.revealFor(userId, this.config.credential, host);
    if (!credential.username) throw new Error(`Credential "${this.config.credential}" needs a username: the email address`);
    return { user: credential.username, pass: credential.secret };
  }
}

/** The messages with these UIDs, in UID order. */
async function fetchMessages(client: ImapFlow, uids: number[]): Promise<EmailMessage[]> {
  const messages: EmailMessage[] = [];
  if (uids.length === 0) return messages;
  for await (const message of client.fetch(
    uids,
    { uid: true, bodyStructure: true, internalDate: true, source: { maxLength: SOURCE_LIMIT } },
    { uid: true },
  )) {
    messages.push(await toEmailMessage(message));
  }
  return messages.sort((a, b) => a.uid - b.uid);
}

/** The Sent folder: the one the server marks \\Sent, else one named like it. */
async function sentMailbox(client: ImapFlow): Promise<string> {
  const boxes = await client.list();
  const marked = boxes.find((box) => box.specialUse === SENT_MAILBOX);
  if (marked) return marked.path;
  const named = boxes.find((box) => /^(sent|sent items|sent messages|\[gmail\]\/sent mail)$/i.test(box.path));
  if (named) return named.path;
  throw new Error("No Sent folder: set sentMailbox");
}

async function toEmailMessage(fetched: FetchMessageObject): Promise<EmailMessage> {
  const parsed = await simpleParser(fetched.source ?? Buffer.alloc(0), { skipImageLinks: true, skipTextToHtml: true });
  const messageId = parsed.messageId ?? "";
  const references = messageIds(parsed.references);
  const inReplyTo = messageIds(parsed.inReplyTo)[0] ?? null;
  const from = firstAddress(parsed.from);
  return {
    uid: fetched.uid,
    messageId,
    threadId: threadIdOf(messageId, inReplyTo, references),
    inReplyTo,
    references,
    from: from?.address ?? "",
    fromName: from?.name || null,
    replyTo: firstAddress(parsed.replyTo)?.address ?? from?.address ?? "",
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    subject: parsed.subject ?? "",
    date: new Date(parsed.date ?? fetched.internalDate ?? 0).toISOString(),
    text: boundedText(parsed.text ?? ""),
    attachments: fetched.bodyStructure ? attachmentsOf(fetched.bodyStructure) : [],
  };
}

function firstAddress(value: AddressObject | AddressObject[] | undefined): { address: string; name: string } | null {
  const first = (Array.isArray(value) ? value : value ? [value] : []).flatMap((a) => a.value)[0];
  return first?.address ? { address: first.address.toLowerCase(), name: first.name } : null;
}

function addresses(value: AddressObject | AddressObject[] | undefined): string[] {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .flatMap((a) => a.value)
    .map((a) => a.address?.toLowerCase())
    .filter((a): a is string => !!a);
}

/** Leaf parts that are attachments: disposition attachment, or a named part that isn't the message text. */
export function attachmentsOf(node: MessageStructureObject): EmailMessage["attachments"] {
  if (node.childNodes?.length) return node.childNodes.flatMap(attachmentsOf);
  const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? null;
  const isText = node.type === "text/plain" || node.type === "text/html";
  if (node.disposition !== "attachment" && (filename === null || isText)) return [];
  return [{ filename, contentType: node.type, size: node.size ?? 0 }];
}

function message(error: unknown): string {
  if (error instanceof Error) {
    const detail = (error as Error & { responseText?: string }).responseText;
    return detail ? `${error.message} (${detail})` : error.message;
  }
  return String(error);
}

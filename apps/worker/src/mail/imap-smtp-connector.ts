import { type KeyRing, open } from "@realentity/storm-crypto";
import { type PrismaClient } from "@realentity/storm-db";
import { LOCAL_MAIL_HOSTS } from "@realentity/storm-shared";
import { type EmailMessage } from "@realentity/storm-steps";
import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import { createTransport } from "nodemailer";
import {
  boundedText,
  messageIds,
  threadIdOf,
  withoutSecret,
  NoEmailAccountError,
  type FetchRequest,
  type FetchResult,
  type MailAttachment,
  type MailConnector,
  type MailWho,
  type OutgoingMail,
  type RecentRequest,
  type SentMail,
  type ThreadMessage,
  SENT_MAILBOX,
} from "./mail-connector";

/** Gmail's All Mail: every message once, archived or sent. */
const ALL_MAILBOX = "\\All";

/** One email account, opened: its servers, and the address and app password it signs in with. */
interface Account {
  emailAccountId: string;
  user: string;
  pass: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  tls: boolean;
}

/** Text is parsed from at most this much of a message; attachments are listed from BODYSTRUCTURE, never downloaded. */
const SOURCE_LIMIT = 2_000_000;
const TIMEOUT_MS = 30_000;

/**
 * IMAP (imapflow) and SMTP (nodemailer) with an app password (docs/design.md §4), per email account (M50-T7). The
 * password is opened per operation, only for that account's own servers, and never appears in errors.
 */
export class ImapSmtpConnector implements MailConnector {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly keys: KeyRing,
  ) {}

  async recent(who: MailWho, request: RecentRequest): Promise<EmailMessage[]> {
    return this.imap(who, async (client, _user, account) => {
      const name = request.mailbox === SENT_MAILBOX ? await sentMailbox(client) : request.mailbox;
      const lock = await client.getMailboxLock(name, { readOnly: true });
      try {
        const found = (await client.search({ since: request.since }, { uid: true })) || [];
        return await fetchMessages(client, found.sort((a, b) => a - b).slice(-request.limit), account);
      } finally {
        lock.release();
      }
    });
  }

  async attachments(who: MailWho, request: { mailbox: string; uid: number; maxBytes: number }): Promise<MailAttachment[]> {
    return this.imap(who, async (client) => {
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

  async thread(who: MailWho, messageIds: string[]): Promise<ThreadMessage[]> {
    const wanted = new Set(messageIds);
    if (wanted.size === 0) return [];
    return this.imap(who, async (client, user, account) => {
      const boxes = await client.list();
      const all = boxes.find((box) => box.specialUse === ALL_MAILBOX)?.path;
      const sent = sentPath(boxes);
      const names = all ? [all] : ["INBOX", ...(sent ? [sent] : [])];
      // HEADER search matches a substring: only exact Message-IDs are kept.
      const ids = [...wanted];
      const query = ids.length === 1 ? { header: { "message-id": ids[0] } } : { or: ids.map((id) => ({ header: { "message-id": id } })) };
      const found = new Map<string, EmailMessage>();
      for (const name of names) {
        const lock = await client.getMailboxLock(name, { readOnly: true });
        try {
          const uids = ((await client.search(query, { uid: true })) || []).sort((a, b) => a - b);
          for (const message of await fetchMessages(client, uids, account)) {
            if (wanted.has(message.messageId) && !found.has(message.messageId)) found.set(message.messageId, message);
          }
        } finally {
          lock.release();
        }
      }
      const me = user.trim().toLowerCase();
      return [...found.values()].sort((a, b) => a.date.localeCompare(b.date)).map((message) => ({ message, mine: message.from === me }));
    });
  }

  /** A read-only IMAP session; errors without the password. */
  private async imap<T>(who: MailWho, work: (client: ImapFlow, user: string, account: string) => Promise<T>): Promise<T> {
    const login = await this.account(who);
    const client = new ImapFlow({
      host: login.imapHost,
      port: login.imapPort,
      secure: login.tls,
      auth: { user: login.user, pass: login.pass },
      logger: false,
      connectionTimeout: TIMEOUT_MS,
      greetingTimeout: TIMEOUT_MS,
      socketTimeout: 5 * TIMEOUT_MS,
    });
    try {
      await client.connect();
      return await work(client, login.user, login.emailAccountId);
    } catch (error) {
      throw new Error(`IMAP: ${withoutSecret(message(error), login.pass)}`);
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  async fetch(who: MailWho, request: FetchRequest): Promise<FetchResult> {
    return this.imap(who, async (client, _user, account) => {
      // "Sent" is the server's Sent folder, whatever it is called there ([Gmail]/Sent Mail, a translated name).
      const name = /^sent$/i.test(request.mailbox) || request.mailbox === SENT_MAILBOX ? await sentMailbox(client) : request.mailbox;
      // Read-only: EXAMINE, so even fetching a body doesn't set \Seen.
      const lock = await client.getMailboxLock(name, { readOnly: true });
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
        const messages = await fetchMessages(client, uids, account);
        // Next time: after the last message returned, or (nothing new) after everything the mailbox has now.
        const lastUid = uids.length > 0 ? uids[uids.length - 1] : Math.max(floor, mailbox.uidNext - 1);
        return { account, messages, position: { uidValidity: mailbox.uidValidity, lastUid } };
      } finally {
        lock.release();
      }
    });
  }

  async send(who: MailWho, mail: OutgoingMail): Promise<SentMail> {
    const login = await this.account(who);
    // A reply to the user's own address answers mail they sent themselves (Storm's own messages): never sent.
    if (mail.inReplyTo && mail.to.trim().toLowerCase() === login.user.trim().toLowerCase()) {
      throw new Error("Not sent: a reply to your own address (mail you sent yourself)");
    }
    const transport = createTransport({
      host: login.smtpHost,
      port: login.smtpPort,
      secure: login.tls,
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
      return { messageId: String(info.messageId), accepted, from: login.user };
    } catch (error) {
      throw new Error(`SMTP: ${withoutSecret(message(error), login.pass)}`);
    } finally {
      transport.close();
    }
  }

  /** The account asked for (the user's), else their default one; its password opened for this use only. */
  private async account(who: MailWho): Promise<Account> {
    const row = who.account
      ? await this.prisma.emailAccount.findFirst({ where: { emailAccountId: who.account, userId: who.userId } })
      : await this.prisma.emailAccount.findFirst({
          where: { userId: who.userId },
          orderBy: [{ isDefault: "desc" }, { dateCreated: "asc" }],
        });
    if (!row) throw new NoEmailAccountError(who.account);
    // The api refuses it too: the app password never travels unencrypted to anything but a local test server.
    if (!row.tls && ![row.imapHost, row.smtpHost].every((host) => LOCAL_MAIL_HOSTS.includes(host))) {
      throw new Error(`${row.address}: TLS is off for a server that isn't local`);
    }
    const pass = open(this.keys, row.emailAccountId, row);
    await this.prisma.emailAccount.update({ where: { emailAccountId: row.emailAccountId }, data: { lastUsedAt: new Date() } });
    return { ...row, user: row.address, pass };
  }
}

/** The messages with these UIDs, in UID order, each marked with the account read. */
async function fetchMessages(client: ImapFlow, uids: number[], account: string): Promise<EmailMessage[]> {
  const messages: EmailMessage[] = [];
  if (uids.length === 0) return messages;
  for await (const message of client.fetch(
    uids,
    { uid: true, bodyStructure: true, internalDate: true, source: { maxLength: SOURCE_LIMIT } },
    { uid: true },
  )) {
    messages.push({ ...(await toEmailMessage(message)), account });
  }
  return messages.sort((a, b) => a.uid - b.uid);
}

/** The Sent folder: the one the server marks \\Sent, else one named like it. */
async function sentMailbox(client: ImapFlow): Promise<string> {
  const path = sentPath(await client.list());
  if (path) return path;
  throw new Error("No Sent folder found: name the folder instead (sentMailbox, or the mailbox to read)");
}

function sentPath(boxes: { path: string; specialUse?: string }[]): string | null {
  const marked = boxes.find((box) => box.specialUse === SENT_MAILBOX);
  if (marked) return marked.path;
  return boxes.find((box) => /^(sent|sent items|sent messages|\[gmail\]\/sent mail)$/i.test(box.path))?.path ?? null;
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

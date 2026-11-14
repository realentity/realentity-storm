import { type PrismaClient } from "@realentity/storm-db";

/**
 * M50-T16: which of the user's email accounts their topics read. A topic's MAILBOX sources name its accounts; a topic
 * without one reads the default account, as before. An email matches only the topics that read its account.
 */
export interface TopicMailboxes {
  /** The default account (the one marked, else the oldest); null without any account. */
  defaultAccount: string | null;
  /** Every account an active topic reads, the default first when any topic reads it. */
  accounts: string[];
  /** A topic's own accounts (its MAILBOX sources); empty: the default account. */
  ofTopic: Map<string, string[]>;
}

export async function topicMailboxes(prisma: PrismaClient, userId: string, topicIds?: string[]): Promise<TopicMailboxes> {
  const [fallback, topics] = await Promise.all([
    prisma.emailAccount.findFirst({
      where: { userId },
      orderBy: [{ isDefault: "desc" }, { dateCreated: "asc" }],
      select: { emailAccountId: true },
    }),
    prisma.topic.findMany({
      where: { userId, status: "ACTIVE", ...(topicIds ? { topicId: { in: topicIds } } : {}) },
      select: { topicId: true, sources: { where: { kind: "MAILBOX", emailAccountId: { not: null } }, select: { emailAccountId: true } } },
    }),
  ]);
  const defaultAccount = fallback?.emailAccountId ?? null;
  const ofTopic = new Map(topics.map((t) => [t.topicId, t.sources.map((s) => s.emailAccountId!)]));
  const accounts = new Set<string>();
  // No topic yet, or one without a mailbox: the default account, as before topics had mailboxes.
  if (defaultAccount && (topics.length === 0 || topics.some((t) => t.sources.length === 0))) accounts.add(defaultAccount);
  for (const t of topics) for (const s of t.sources) accounts.add(s.emailAccountId!);
  return { defaultAccount, accounts: [...accounts], ofTopic };
}

/**
 * Whether a topic reads the account an email came from. An email whose account isn't known (read before accounts, or
 * from elsewhere) may be any topic's.
 */
export function topicReads(mailboxes: TopicMailboxes, topicId: string, account: string | null | undefined): boolean {
  if (!account) return true;
  const own = mailboxes.ofTopic.get(topicId) ?? [];
  return own.length > 0 ? own.includes(account) : account === mailboxes.defaultAccount;
}

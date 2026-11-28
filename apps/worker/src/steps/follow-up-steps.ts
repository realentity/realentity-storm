import { type PrismaClient } from "@realentity/storm-db";
import { embeddingsSource, type Embeddings, type EmbeddingsSource, type LlmClient, type ModelRouter } from "@realentity/storm-llm";
import { type EmailMessage } from "@realentity/storm-steps";
import { z } from "zod";
import { type StepLearning } from "../learning/learning";
import { mailWho, SENT_MAILBOX, type MailConnector } from "../mail/mail-connector";
import { type StepContext, type StepExecutor } from "../runner/step-executor";
import { emailBlock } from "./email-block";
import { readThread, THREAD_RULE } from "./email-thread";
import { replySubject } from "./email-steps";
import { DATA_ONLY, EXAMPLES_RULE, LlmStep } from "./llm-steps";
import { drewOn, MEMORY_RULE, topicMemory, UsedFacts } from "./topic-context";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Per mailbox and run: enough for a month of the user's own email. */
const READ_LIMIT = 300;
/** Automatic senders: a follow-up to them reaches nobody. */
const NOBODY = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?)@/i;

interface AwaitingInput {
  afterDays: number;
  lookbackDays: number;
  mailbox: string;
  sentMailbox?: string;
  maxFollowUps: number;
  limit: number;
  /** M50-T7: an email slot, or an account's id; default: the default account. */
  account?: string;
}

/**
 * email.awaiting (M22): the user's emails nobody answered. A thread waits for an answer when its last message is
 * theirs, older
 * than afterDays, and nothing came back in it since (by Message-ID, In-Reply-To and References, not by subject). It
 * remembers nothing (M71): every such thread each run; the pipeline keeps track (an App's rows, data.dedupe against a
 * collection).
 */
export class EmailAwaitingStep implements StepExecutor {
  readonly type = "email.awaiting";

  constructor(private readonly mail: MailConnector) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const {
      afterDays,
      lookbackDays,
      mailbox,
      sentMailbox,
      maxFollowUps,
      limit,
      account,
    } = input as unknown as AwaitingInput;
    const who = mailWho(context, account);
    const now = Date.now();
    const since = new Date(now - lookbackDays * DAY_MS);
    const [sent, received] = await Promise.all([
      this.mail.recent(who, { mailbox: sentMailbox ?? SENT_MAILBOX, since, limit: READ_LIMIT }),
      this.mail.recent(who, { mailbox, since, limit: READ_LIMIT }),
    ]);
    const mine = new Set(sent.map((m) => m.messageId));

    const threads = [...groupBy(sent, (m) => m.threadId).values()].flatMap((emails) => {
      const ordered = [...emails].sort((a, b) => time(a) - time(b));
      const last = ordered.at(-1)!;
      const to = last.to[0];
      if (!to || NOBODY.test(to)) return [];
      if (now - time(last) < afterDays * DAY_MS) return [];
      const ids = new Set(ordered.flatMap((m) => [m.messageId, ...m.references, ...(m.inReplyTo ? [m.inReplyTo] : [])]));
      const answers = received.filter((m) => !mine.has(m.messageId) && inThread(m, ids));
      const lastAnswer = Math.max(0, ...answers.map(time));
      if (lastAnswer > time(last)) return [];
      // The user's messages since the other side's last answer: the first one, then the follow-ups.
      const followUps = ordered.filter((m) => time(m) > lastAnswer).length - 1;
      if (followUps >= maxFollowUps) return [];
      return [
        {
          threadId: last.threadId,
          to,
          subject: last.subject,
          sentAt: last.date,
          daysWaiting: Math.floor((now - time(last)) / DAY_MS),
          followUps,
          message: last,
          references: [...last.references.filter((id) => id !== last.messageId), last.messageId],
        },
      ];
    });
    // The longest waiting first.
    const listed = threads.sort((a, b) => b.daysWaiting - a.daysWaiting).slice(0, limit);
    return { threads: listed };
  }
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

function inThread(message: EmailMessage, ids: Set<string>): boolean {
  return (
    ids.has(message.threadId) || (message.inReplyTo !== null && ids.has(message.inReplyTo)) || message.references.some((id) => ids.has(id))
  );
}

function time(message: EmailMessage): number {
  return new Date(message.date).getTime();
}

/** email.draftFollowUp (M22): a nudge to the user's own email that got no answer (Sonnet by default). */
export class DraftFollowUpStep extends LlmStep {
  readonly type = "email.draftFollowUp";

  constructor(
    llm: LlmClient,
    router: ModelRouter,
    learning?: StepLearning,
    private readonly mail?: MailConnector,
    private readonly prisma?: PrismaClient,
    private readonly embeddings?: Embeddings | EmbeddingsSource | null,
  ) {
    super(llm, router, learning);
  }

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const {
      message,
      instruction,
      daysWaiting,
      signature,
      topic = "auto",
    } = input as {
      message: EmailMessage;
      instruction: string;
      daysWaiting?: number;
      signature?: string;
      topic?: string;
    };
    const memory = await topicMemory(this.prisma, context.userId, message, topic, {
      embeddings: (await embeddingsSource(this.embeddings)?.current(context.userId)) ?? null,
      recordUsage: (usage) => context.recordUsage(usage),
    });
    const system = [
      "You draft a follow-up for the user: <email> is an email they sent that got no answer. The follow-up goes in the " +
        "same thread to its recipient, to be reviewed and sent by the user. Rules:",
      "- Write in the language of the user's email.",
      "- Short: a greeting, two or three sentences, a sign-off. Refer to the user's email; don't repeat it.",
      '- Polite and without pressure: no guilt, no deadline, no "just checking in" filler twice.',
      "- Add no new facts, dates, prices, offers or commitments (beyond <memory>, if given); where one would be needed, a " +
        "placeholder like [date].",
      "- Plain text, no subject line, no quoted original.",
      signature ? "- End with the user's signature exactly as given." : "- End with a short sign-off, without a name.",
      `- ${THREAD_RULE} Follow up on <email>, the user's latest.`,
      ...(memory.block ? [`- ${MEMORY_RULE}`] : []),
      `- ${EXAMPLES_RULE}`,
      DATA_ONLY,
      `<instruction>${instruction}</instruction>`,
      ...(daysWaiting === undefined ? [] : [`<waiting>${daysWaiting} days without an answer</waiting>`]),
      ...(signature ? [`<signature>\n${signature}\n</signature>`] : []),
    ].join("\n");
    const schema = z.object({
      body: z.string().min(1),
      language: z.string().min(2).max(16).describe("ISO 639-1 code of the follow-up's language, e.g. en, bg"),
      ...(memory.block ? { used: UsedFacts } : {}),
    });
    const email = emailBlock(message);
    const [examples, thread] = await Promise.all([
      this.examplesFor(context, email),
      readThread(this.mail, mailWho(context, message.account), message),
    ]);
    const draft = await this.call(
      context,
      system,
      `${examples}${thread}${memory.passages}${email}`,
      schema,
      true,
      memory.block || undefined,
    );
    return {
      subject: replySubject(message.subject),
      body: draft.body.trim(),
      language: draft.language.toLowerCase(),
      drewOn: drewOn(memory, (draft as { used?: string[] }).used ?? []),
    };
  }
}

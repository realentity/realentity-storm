import { type PrismaClient } from "@ai-me/db";
import { type LlmClient, type ModelRouter } from "@ai-me/llm";
import { type EmailMessage } from "@ai-me/steps";
import { z } from "zod";
import { type MailConnector } from "../mail/mail-connector";
import { type StepContext, type StepExecutor } from "../runner/step-executor";
import { type StepLearning } from "../learning/learning";
import { emailBlock } from "./email-block";
import { DATA_ONLY, EXAMPLES_RULE, LlmStep } from "./llm-steps";

export { emailBlock };

const DAY_MS = 24 * 60 * 60 * 1000;
/** Per email in a classification prompt: the opening is enough to triage. */
const TRIAGE_TEXT = 3_000;

/**
 * email.fetch: new messages since this pipeline's last read (MailCursor), oldest first. A dry run reads but
 * doesn't move the cursor, so the real run still sees the same messages.
 */
export class EmailFetchStep implements StepExecutor {
  readonly type = "email.fetch";

  constructor(
    private readonly mail: MailConnector,
    private readonly prisma: PrismaClient,
  ) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { mailbox, limit, sinceDays } = input as { mailbox: string; limit: number; sinceDays: number };
    const where = { pipelineId_mailbox: { pipelineId: context.pipelineId, mailbox } };
    const cursor = await this.prisma.mailCursor.findUnique({ where });
    const result = await this.mail.fetch(context.userId, {
      mailbox,
      after: cursor ? { uidValidity: cursor.uidValidity, lastUid: Number(cursor.lastUid) } : null,
      since: new Date(Date.now() - sinceDays * DAY_MS),
      limit,
    });
    if (!context.dryRun) {
      const position = { uidValidity: result.position.uidValidity, lastUid: BigInt(result.position.lastUid) };
      await this.prisma.mailCursor.upsert({
        where,
        create: { userId: context.userId, pipelineId: context.pipelineId, mailbox, ...position },
        update: position,
      });
    }
    return { messages: result.messages };
  }
}

/** email.classify: one label per email (Haiku by default); emails with a `keep` label go to `kept`. */
export class EmailClassifyStep extends LlmStep {
  readonly type = "email.classify";

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { messages, instruction, labels, keep } = input as {
      messages: EmailMessage[];
      instruction: string;
      labels: string[];
      keep: string[];
    };
    const schema = z.object({
      results: z.array(z.object({ index: z.number().int(), label: z.enum(labels as [string, ...string[]]), reason: z.string() })),
    });
    // My instruction and the labels are the same for every chunk: they live in the (cached) system prompt.
    const system =
      "You triage emails for my personal automation pipeline. Give every email exactly one of the allowed labels and a " +
      `one-sentence reason, using the email's index. ${DATA_ONLY}\n` +
      `<instruction>${instruction}</instruction>\n<labels>${labels.join(", ")}</labels>`;
    const results = await this.perItem(
      messages.map((m, index) => ({ index, ...m })),
      (chunk) => this.call(context, system, chunk, schema, true),
      (index) => emailBlock(messages[index], TRIAGE_TEXT, index),
    );
    // email.classified (M12-T1): one event per labelled email, for the pipelines that act on a label.
    for (const r of results) {
      const message = messages[r.index];
      if (message) await context.emit?.("email.classified", { label: r.label, reason: r.reason, message });
    }
    return {
      kept: results.filter((r) => keep.includes(r.label)).map((r) => messages[r.index]),
      dropped: results.filter((r) => !keep.includes(r.label)).map((r) => messages[r.index]),
      results,
    };
  }
}

/**
 * email.draftReply: a reply to one email (Sonnet by default). Only a body: the subject is the original's with "Re:",
 * and the recipient is never the LLM's to choose (it comes from the fetched email at email.send).
 */
export class DraftReplyStep extends LlmStep {
  readonly type = "email.draftReply";

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const {
      message,
      instruction,
      context: background,
      signature,
    } = input as {
      message: EmailMessage;
      instruction: string;
      context?: unknown;
      signature?: string;
    };
    const system = [
      "You draft email replies for me, to be reviewed and sent by me. Rules:",
      "- Reply in the language the email is written in.",
      "- Use only facts from the email, my instruction and my background. Never invent dates, prices, rates, availability, " +
        "names, links or commitments; where one is needed and unknown, write a placeholder like [date] for me to fill in.",
      "- Never accept, confirm or propose a date, time, rate or term on my behalf (not even one the sender offered): " +
        "leave it to me with a placeholder like [my available times] or [my rate].",
      "- Don't state anything about me (my experience, skills, situation, what I have read or done) beyond my background, " +
        "and don't promise follow-ups with a deadline.",
      "- Plain text, no subject line, no quoted original. Start with the greeting.",
      signature ? "- End with my signature exactly as given." : "- End with a short sign-off, without a name.",
      `- ${EXAMPLES_RULE}`,
      DATA_ONLY,
      `<instruction>${instruction}</instruction>`,
      ...(background === undefined
        ? []
        : [`<context>\n${typeof background === "string" ? background : JSON.stringify(background, null, 2)}\n</context>`]),
      ...(signature ? [`<signature>\n${signature}\n</signature>`] : []),
    ].join("\n");
    const schema = z.object({
      body: z.string().min(1),
      language: z.string().min(2).max(16).describe("ISO 639-1 code of the reply's language, e.g. en, bg"),
    });
    const email = emailBlock(message);
    const examples = await this.examplesFor(context, email);
    const draft = await this.call(context, system, `${examples}${email}`, schema, true);
    return { subject: replySubject(message.subject), body: draft.body.trim(), language: draft.language.toLowerCase() };
  }
}

export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  return /^(re|aw|отн)\s*:/i.test(trimmed) ? trimmed : `Re: ${trimmed || "(no subject)"}`;
}

/** email.send: exactly the approved payload; a reply in the thread when `inReplyTo` is set. */
export class EmailSendStep implements StepExecutor {
  readonly type = "email.send";

  constructor(private readonly mail: MailConnector) {}

  execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { to, subject, body, inReplyTo, references } = input as {
      to: string;
      subject: string;
      body: string;
      inReplyTo?: string;
      references?: string[];
    };
    // The thread is the original's references plus the message replied to (RFC 5322 §3.6.4).
    const thread = inReplyTo ? [...(references ?? []).filter((id) => id !== inReplyTo), inReplyTo] : references;
    return this.mail.send(context.userId, { to, subject, body, inReplyTo, references: thread });
  }
}

export interface EmailStepDependencies {
  mail: MailConnector;
  prisma: PrismaClient;
  llm: LlmClient;
  router: ModelRouter;
  learning?: StepLearning;
}

export function emailSteps(deps: EmailStepDependencies): StepExecutor[] {
  return [
    new EmailFetchStep(deps.mail, deps.prisma),
    new EmailClassifyStep(deps.llm, deps.router, deps.learning),
    new DraftReplyStep(deps.llm, deps.router, deps.learning),
    new EmailSendStep(deps.mail),
  ];
}

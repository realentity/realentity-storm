import { type Prisma, type PrismaClient, type TopicBackfill } from "@realentity/storm-db";
import { addUsage, costUsd, emptyUsage, type LlmBatches, type LlmUsage, type ModelRouter } from "@realentity/storm-llm";
import { matchDirections } from "@realentity/storm-shared";
import { type EmailMessage, type TopicProposal } from "@realentity/storm-steps";
import { Logger } from "@nestjs/common";
import { SENT_MAILBOX, type MailConnector } from "../mail/mail-connector";
import { type RunControls } from "../runner/run-controls";
import {
  addProposals,
  emailEvidence,
  extractRequest,
  fileEvidence,
  screenBlock,
  SCREEN,
  SCREEN_SCHEMA,
  topicCards,
  type Evidence,
} from "../steps/topic-memory-steps";

/** Emails read per mailbox when looking for a topic's history, at most (the newest). */
export const HISTORY_EMAILS = 1_000;
/** A piece of evidence as the models read it, at most (topic.extract's own limit). */
const EVIDENCE_TEXT = 6_000;
/** The share the screen is expected to pass on to the writing model, for the estimate. */
const WORTH_SHARE = 0.3;
/** Message-IDs read from the mailbox per search. */
const IDS_PER_READ = 50;
const POLL_EVERY_MS = 10 * 60 * 1000;
const GIVE_UP_MS = 25 * 60 * 60 * 1000;

interface FoundEmail {
  messageId: string;
  date: string;
}

interface FoundFile {
  topicSourceId: string;
  path: string;
}

/**
 * A topic's backfill (M43-T5, docs/design.md §8.1): its history read for facts. The estimate finds its past emails by its
 * exact directions and their threads (no LLM) and its sources' indexed documents, and prices reading them; once the user
 * starts it, the cheap model screens them and the writing model proposes facts, both through the Batch API at half the
 * price; the proposals wait for the user. The same prompts and checks as topic.extract.
 */
export class TopicBackfills {
  private readonly logger = new Logger(TopicBackfills.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly mail: MailConnector,
    private readonly batches: LlmBatches | null,
    private readonly router: ModelRouter,
    private readonly controls: Pick<RunControls, "overBudget">,
    private readonly later: (topicBackfillId: string, startAfter: Date) => Promise<void>,
  ) {}

  /** The topic-backfill job: the backfill moves on from where it is. */
  async step(topicBackfillId: string, now = new Date()): Promise<void> {
    const backfill = await this.prisma.topicBackfill.findUnique({ where: { topicBackfillId } });
    if (!backfill) return;
    try {
      if (backfill.status === "ESTIMATING") await this.estimate(backfill, now);
      else if (backfill.status === "SCREENING" || backfill.status === "PROPOSING") await this.read(backfill, now);
    } catch (error) {
      await this.fail(topicBackfillId, error instanceof Error ? error.message : String(error));
    }
  }

  /** The topic's past emails and documents, and what reading them would cost. */
  private async estimate(backfill: TopicBackfill, now: Date): Promise<void> {
    const topic = await this.prisma.topic.findUniqueOrThrow({ where: { topicId: backfill.topicId }, include: { directions: true } });
    const since = new Date(now.getTime());
    since.setMonth(since.getMonth() - backfill.months);
    const [inbox, sent, linked] = await Promise.all([
      this.mail.recent(backfill.userId, { mailbox: "INBOX", since, limit: HISTORY_EMAILS }),
      this.mail.recent(backfill.userId, { mailbox: SENT_MAILBOX, since, limit: HISTORY_EMAILS }).catch(() => [] as EmailMessage[]),
      this.prisma.topicLink.findMany({
        where: { topicId: topic.topicId, status: { in: ["LINKED", "CONFIRMED"] } },
        select: { threadId: true },
      }),
    ]);
    const all = [...new Map([...inbox, ...sent].filter((m) => m.messageId).map((m) => [m.messageId, m])).values()];
    // An exact direction, then everything in the threads it found (and those already linked).
    const direct = all.filter((m) => matchDirections(m, topic.directions).exact !== null);
    const threads = new Set([...linked.map((l) => l.threadId), ...direct.map((m) => m.threadId)]);
    const emails = all.filter((m) => threads.has(m.threadId)).sort((a, b) => a.date.localeCompare(b.date));

    const files = backfill.documents ? await this.documents(backfill) : [];
    const sizes = [
      ...emails.map((m) => Math.min(m.text.length, EVIDENCE_TEXT) + m.subject.length),
      ...files.map((f) => Math.min(f.text.length, EVIDENCE_TEXT)),
    ];
    const [screen, write] = await Promise.all([
      this.router.choose(backfill.userId, "topic.extract.screen"),
      this.router.choose(backfill.userId, "topic.extract"),
    ]);
    const tokens = (chars: number) => Math.ceil(chars / 4);
    const screenCost = costUsd(screen.model, {
      inputTokens: sizes.reduce((sum, c) => sum + tokens(c) + 400, 0),
      outputTokens: sizes.length * 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const writeCost = costUsd(write.model, {
      inputTokens: Math.ceil(sizes.reduce((sum, c) => sum + tokens(c) + 2_000, 0) * WORTH_SHARE),
      outputTokens: Math.ceil(sizes.length * WORTH_SHARE * 400),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    await this.prisma.topicBackfill.update({
      where: { topicBackfillId: backfill.topicBackfillId },
      data: {
        status: "ESTIMATED",
        emails: emails.map((m): FoundEmail => ({ messageId: m.messageId, date: m.date })) as unknown as Prisma.InputJsonValue,
        files: files.map((f): FoundFile => ({ topicSourceId: f.topicSourceId, path: f.path })) as unknown as Prisma.InputJsonValue,
        // The Batch API's half price.
        estimateUsd: Math.round((screenCost + writeCost) * 0.5 * 10_000) / 10_000,
      },
    });
  }

  /** Submits the next batch, or reads the one submitted once it has ended. */
  private async read(backfill: TopicBackfill, now: Date): Promise<void> {
    if (!this.batches) return this.fail(backfill.topicBackfillId, "The LLM isn't set up (ANTHROPIC_API_KEY)");
    if (!backfill.batchId) {
      if (await this.controls.overBudget(backfill.userId)) return this.fail(backfill.topicBackfillId, "The monthly LLM budget is reached");
      return this.submit(backfill, now);
    }
    if (!(await this.batches.ended(backfill.batchId))) {
      if (now.getTime() - backfill.dateCreated.getTime() > GIVE_UP_MS * 2)
        return this.fail(backfill.topicBackfillId, "The batch did not end in time");
      return this.later(backfill.topicBackfillId, new Date(now.getTime() + POLL_EVERY_MS));
    }
    if (backfill.status === "SCREENING") {
      const choice = await this.router.choose(backfill.userId, "topic.extract.screen");
      const results = await this.batches.results(backfill.batchId, SCREEN_SCHEMA, choice.model);
      const worth = results.filter((r) => r.ok && r.output.results.some((x) => x.worth)).map((r) => Number(r.customId));
      const usage = results.reduce((sum, r) => addUsage(sum, r.usage), this.usage(backfill));
      await this.prisma.topicBackfill.update({
        where: { topicBackfillId: backfill.topicBackfillId },
        data: {
          status: worth.length ? "PROPOSING" : "REVIEW",
          worth: worth,
          batchId: null,
          llmUsage: usage as unknown as Prisma.InputJsonValue,
          ...(worth.length ? {} : { finishedAt: now }),
        },
      });
      if (worth.length) await this.later(backfill.topicBackfillId, now);
      return;
    }
    const evidence = await this.evidence(backfill);
    const choice = await this.router.choose(backfill.userId, "topic.extract");
    const cards = await this.cards(backfill, evidence);
    const proposals: TopicProposal[] = [];
    let usage = this.usage(backfill);
    const indexes = ((backfill.worth as number[] | null) ?? []).filter((i) => evidence[i] && !evidence[i].gone);
    if (indexes.length) {
      // One topic: every request's answer has the same shape.
      const shape = extractRequest(evidence[indexes[0]], cards).schema;
      for (const result of await this.batches.results(backfill.batchId, shape, choice.model)) {
        usage = addUsage(usage, result.usage);
        const piece = evidence[Number(result.customId)];
        if (result.ok && piece) addProposals(proposals, extractRequest(piece, cards).read(result.output));
      }
    }
    await this.prisma.topicBackfill.update({
      where: { topicBackfillId: backfill.topicBackfillId },
      data: {
        status: "REVIEW",
        batchId: null,
        proposals: proposals,
        llmUsage: usage as unknown as Prisma.InputJsonValue,
        finishedAt: now,
      },
    });
    this.logger.log(`Backfill read: ${proposals.length} proposal(s)`);
  }

  private async submit(backfill: TopicBackfill, now: Date): Promise<void> {
    const evidence = await this.evidence(backfill);
    const readable = evidence.map((piece, index) => ({ piece, index })).filter(({ piece }) => !piece.gone);
    if (readable.length === 0) {
      await this.prisma.topicBackfill.update({
        where: { topicBackfillId: backfill.topicBackfillId },
        data: { status: "REVIEW", finishedAt: now },
      });
      return;
    }
    let batchId: string;
    if (backfill.status === "SCREENING") {
      const choice = await this.router.choose(backfill.userId, "topic.extract.screen");
      // One request per piece: the answers are matched by its index.
      batchId = await this.batches!.submit(
        readable.map(({ piece, index }) => ({
          customId: String(index),
          request: { choice, system: SCREEN, prompt: screenBlock(piece, 0), schema: SCREEN_SCHEMA, cacheSystem: true },
        })),
      );
    } else {
      const choice = await this.router.choose(backfill.userId, "topic.extract");
      const cards = await this.cards(backfill, evidence);
      const indexes = ((backfill.worth as number[] | null) ?? []).filter((i) => evidence[i] && !evidence[i].gone);
      batchId = await this.batches!.submit(
        indexes.map((index) => {
          const request = extractRequest(evidence[index], cards);
          return {
            customId: String(index),
            request: { choice, system: request.system, prompt: request.prompt, schema: request.schema, cacheSystem: true },
          };
        }),
      );
    }
    await this.prisma.topicBackfill.update({ where: { topicBackfillId: backfill.topicBackfillId }, data: { batchId } });
    await this.later(backfill.topicBackfillId, new Date(now.getTime() + POLL_EVERY_MS));
  }

  /** The emails (read again from the mailbox: Storm keeps no email text) and documents found, in the estimate's order. */
  private async evidence(backfill: TopicBackfill): Promise<(Evidence & { gone?: boolean })[]> {
    const topic = await this.prisma.topic.findUniqueOrThrow({ where: { topicId: backfill.topicId } });
    const topics = [{ topicId: topic.topicId, name: topic.name, description: topic.description }];
    const found = backfill.emails as unknown as FoundEmail[];
    const read = new Map<string, EmailMessage>();
    for (let start = 0; start < found.length; start += IDS_PER_READ) {
      const ids = found.slice(start, start + IDS_PER_READ).map((e) => e.messageId);
      for (const { message } of await this.mail.thread(backfill.userId, ids)) read.set(message.messageId, message);
    }
    // An email no longer in the mailbox keeps its place, empty, so the indexes stay the same.
    const emails = found.map((e) => {
      const message = read.get(e.messageId);
      return message ? emailEvidence(message, topics) : emptyEvidence(e, topics);
    });
    const wanted = backfill.files as unknown as FoundFile[];
    const files = backfill.documents ? await this.documents(backfill) : [];
    const documents = wanted.map((w) => {
      const file = files.find((f) => f.topicSourceId === w.topicSourceId && f.path === w.path);
      return file
        ? fileEvidence(
            {
              topic: topic.name,
              topicId: topic.topicId,
              sourceId: file.topicSourceId,
              repo: file.location,
              path: file.path,
              status: "modified",
              commit: file.ref,
              commitDate: file.refDate.toISOString(),
              url: `https://github.com/${file.location}/blob/${file.ref}/${file.path}`,
              text: file.text,
              firstRead: false,
            },
            topics,
          )
        : emptyEvidence({ messageId: `${w.topicSourceId}:${w.path}`, date: new Date(0).toISOString() }, topics);
    });
    return [...emails, ...documents];
  }

  /** A topic's documents, from its index (the passages joined again): no call to GitHub. */
  private async documents(backfill: TopicBackfill) {
    const passages = await this.prisma.topicPassage.findMany({
      where: { topicId: backfill.topicId, source: { kind: "GITHUB" } },
      include: { source: true },
      orderBy: [{ topicSourceId: "asc" }, { path: "asc" }, { ordinal: "asc" }],
    });
    const files = new Map<string, { topicSourceId: string; location: string; path: string; ref: string; refDate: Date; text: string }>();
    for (const p of passages) {
      const key = `${p.topicSourceId}\n${p.path}`;
      const file = files.get(key) ?? {
        topicSourceId: p.topicSourceId,
        location: p.source.location,
        path: p.path,
        ref: p.ref,
        refDate: p.refDate,
        text: "",
      };
      file.text += `${file.text ? "\n\n" : ""}${p.heading ? `## ${p.heading}\n\n` : ""}${p.text}`;
      files.set(key, file);
    }
    return [...files.values()];
  }

  private async cards(backfill: TopicBackfill, evidence: Evidence[]) {
    return topicCards(this.prisma, backfill.userId, evidence[0]?.topics ?? []);
  }

  private usage(backfill: TopicBackfill): LlmUsage {
    return (backfill.llmUsage as unknown as LlmUsage | null) ?? emptyUsage();
  }

  private async fail(topicBackfillId: string, error: string): Promise<void> {
    await this.prisma.topicBackfill.update({
      where: { topicBackfillId },
      data: { status: "FAILED", error: error.slice(0, 1000), finishedAt: new Date() },
    });
    this.logger.warn(`Backfill failed: ${error}`);
  }
}

/** An email no longer in the mailbox, or a document no longer indexed: nothing to read, its place kept. */
function emptyEvidence(found: FoundEmail, topics: Evidence["topics"]): Evidence & { gone: true } {
  return {
    gone: true,
    source: { kind: "email", messageId: found.messageId, from: "", subject: "", date: found.date },
    who: "",
    topics,
    block: (index) => `<email${index === undefined ? "" : ` index="${index}"`}>\n(gone)\n</email>`,
  };
}

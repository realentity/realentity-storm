import { applyProposal, type TopicBackfill } from "@realentity/storm-db";
import { JobQueue } from "@realentity/storm-queue";
import { looksSecret, type TopicBackfillView } from "@realentity/storm-shared";
import { TopicProposalSchema } from "@realentity/storm-steps";
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../database/prisma.service";

const OPEN = ["ESTIMATING", "ESTIMATED", "SCREENING", "PROPOSING", "REVIEW"] as const;

/**
 * A topic's backfill (M43-T5, docs/design.md §8.1): its history read for facts. An estimate first; nothing is read by an
 * LLM until the user starts it; its proposals wait for the user like a gate's, and only the ones they pick are written.
 */
@Injectable()
export class TopicBackfillsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(JobQueue) private readonly queue: JobQueue,
  ) {}

  async latest(userId: string, topicId: string): Promise<TopicBackfillView | null> {
    await this.ownTopic(userId, topicId);
    const backfill = await this.prisma.client.topicBackfill.findFirst({ where: { userId, topicId }, orderBy: { dateCreated: "desc" } });
    return backfill ? backfillView(backfill) : null;
  }

  /** Finds the topic's history and prices reading it; one backfill of a topic at a time. */
  async estimate(userId: string, topicId: string, request: { months: number; documents: boolean }): Promise<TopicBackfillView> {
    await this.ownTopic(userId, topicId);
    if (await this.prisma.client.topicBackfill.findFirst({ where: { topicId, status: { in: [...OPEN] } } })) {
      throw new ConflictException("The topic's history is being read already: finish or cancel that first");
    }
    const backfill = await this.prisma.client.topicBackfill.create({ data: { userId, topicId, ...request } });
    await this.queue.enqueueBackfill(backfill.topicBackfillId);
    return backfillView(backfill);
  }

  /** The user agrees to the estimate: the batches go. */
  async start(userId: string, topicBackfillId: string): Promise<TopicBackfillView> {
    const backfill = await this.own(userId, topicBackfillId);
    if (backfill.status !== "ESTIMATED") throw new ConflictException(`It is ${backfill.status.toLowerCase()}, not waiting to start`);
    const started = await this.prisma.client.topicBackfill.update({ where: { topicBackfillId }, data: { status: "SCREENING" } });
    await this.queue.enqueueBackfill(topicBackfillId);
    return backfillView(started);
  }

  async cancel(userId: string, topicBackfillId: string): Promise<TopicBackfillView> {
    const backfill = await this.own(userId, topicBackfillId);
    if (!(OPEN as readonly string[]).includes(backfill.status)) throw new ConflictException("It is finished already");
    return backfillView(
      await this.prisma.client.topicBackfill.update({ where: { topicBackfillId }, data: { status: "CANCELLED", finishedAt: new Date() } }),
    );
  }

  /** Writes the proposals the user picked (by their place in the list), like topic.apply after a gate. */
  async apply(userId: string, topicBackfillId: string, picked: number[]): Promise<TopicBackfillView> {
    const backfill = await this.own(userId, topicBackfillId);
    if (backfill.status !== "REVIEW") throw new ConflictException("Its proposals aren't waiting for you");
    const proposals = z.array(TopicProposalSchema).parse(backfill.proposals);
    if (picked.some((i) => i < 0 || i >= proposals.length)) throw new BadRequestException("No such proposal");
    let applied = 0;
    for (const index of [...new Set(picked)].sort((a, b) => a - b)) {
      const proposal = proposals[index];
      if (looksSecret(`${proposal.about} ${proposal.statement} ${proposal.quote}`)) continue;
      if (proposal.topicId !== backfill.topicId) continue;
      const outcome = await applyProposal(this.prisma.client, userId, proposal, null);
      if (outcome.applied) applied++;
    }
    return backfillView(
      await this.prisma.client.topicBackfill.update({
        where: { topicBackfillId },
        data: { status: "DONE", applied, finishedAt: new Date() },
      }),
    );
  }

  private async own(userId: string, topicBackfillId: string): Promise<TopicBackfill> {
    const backfill = await this.prisma.client.topicBackfill.findFirst({ where: { topicBackfillId, userId } });
    if (!backfill) throw new NotFoundException();
    return backfill;
  }

  private async ownTopic(userId: string, topicId: string): Promise<void> {
    if (!(await this.prisma.client.topic.findFirst({ where: { topicId, userId }, select: { topicId: true } })))
      throw new NotFoundException();
  }
}

function backfillView(b: TopicBackfill): TopicBackfillView {
  const proposals = (b.proposals as { title: string; quote: string; kind: string }[] | null) ?? [];
  return {
    topicBackfillId: b.topicBackfillId,
    topicId: b.topicId,
    months: b.months,
    documents: b.documents,
    status: b.status,
    emails: Array.isArray(b.emails) ? b.emails.length : 0,
    files: Array.isArray(b.files) ? b.files.length : 0,
    estimateUsd: b.estimateUsd,
    costUsd: ((b.llmUsage as { costUsd?: number } | null)?.costUsd ?? 0) || null,
    proposals: b.status === "REVIEW" ? proposals.map((p) => ({ title: p.title, quote: p.quote, kind: p.kind })) : [],
    applied: b.applied,
    error: b.error,
    dateCreated: b.dateCreated.toISOString(),
    finishedAt: b.finishedAt?.toISOString() ?? null,
  };
}

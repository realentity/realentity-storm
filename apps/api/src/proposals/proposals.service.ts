import { payloadHash } from "@realentity/storm-crypto";
import { Prisma } from "@realentity/storm-db";
import { JobQueue } from "@realentity/storm-queue";
import {
  canonicalJson,
  type ApproveProposalRequest,
  type CompiledDefinition,
  type ProposalStatusName,
  type ProposalView,
} from "@realentity/storm-shared";
import { StepCatalog } from "@realentity/storm-steps";
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { z } from "zod";
import { ControlsService } from "../controls/controls.service";
import { PrismaService } from "../database/prisma.service";
import { EventsService } from "../events/events.service";
import { TelegramNotices } from "../telegram/telegram-notices";
import { PROPOSAL_INCLUDE, proposalView, type ProposalWithContext } from "./proposal-view";

type Via = "the app" | "Telegram";

const ReviewSelectionSchema = z.object({ items: z.array(z.unknown()) }).strict();

/** What the worker writes on the steps a rejection skips (pipeline-runner). */
const REJECTED_AT_GATE = "Rejected at the gate";

/**
 * My decisions on proposals (README §3). A decision records the exact payload and its hash, then queues the run:
 * the worker executes only that payload, and only if the hash still matches.
 */
@Injectable()
export class ProposalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: StepCatalog,
    private readonly controls: ControlsService,
    private readonly queue: JobQueue,
    private readonly events: EventsService,
    private readonly telegram: TelegramNotices,
  ) {}

  async list(userId: string, status: ProposalStatusName): Promise<ProposalView[]> {
    const proposals = await this.prisma.client.proposal.findMany({
      where: { userId, status },
      include: PROPOSAL_INCLUDE,
      orderBy: [{ dateCreated: "asc" }, { itemIndex: "asc" }],
    });
    return proposals.map(proposalView);
  }

  async get(userId: string, proposalId: string): Promise<ProposalView> {
    return proposalView(await this.find(userId, proposalId));
  }

  /** `via`: where I decided, for the Storm bot's message about it. */
  async approve(userId: string, proposalId: string, body: ApproveProposalRequest, via: Via = "the app"): Promise<ProposalView> {
    await this.controls.assertNotPaused(userId);
    const proposal = await this.find(userId, proposalId);
    assertPending(proposal);
    const original = proposal.originalPayload as Record<string, unknown>;
    const final = body.payload ? this.validEdit(proposal, body.payload) : original;
    const edited = canonicalJson(final) !== canonicalJson(original);

    await this.decide(proposal, {
      proposal: {
        status: "APPROVED",
        finalPayload: final as Prisma.InputJsonValue,
        payloadHash: payloadHash(final),
        approvedNewTargets: body.approveNewTargets,
      },
      decision: { kind: edited ? "EDITED" : "APPROVED", diff: edited ? { changed: changedFields(original, final) } : undefined },
    });
    await this.telegram.decided(proposalId, `✅ Approved${edited ? " with edits" : ""} in ${via}`);
    return this.get(userId, proposalId);
  }

  async reject(userId: string, proposalId: string, reason: string | undefined, via: Via = "the app"): Promise<ProposalView> {
    const proposal = await this.find(userId, proposalId);
    assertPending(proposal);
    await this.decide(proposal, { proposal: { status: "REJECTED" }, decision: { kind: "REJECTED", reason: reason ?? null } });
    await this.telegram.decided(proposalId, `✖ Rejected in ${via}`);
    return this.get(userId, proposalId);
  }

  /**
   * A rejection by mistake: the proposal waits for my decision again. Only while its run waits for me and nothing went
   * on since the rejection but other items of the same list; the rejection's skips are undone, and its decision goes,
   * so reflection never learns from it.
   */
  async undoReject(userId: string, proposalId: string): Promise<ProposalView> {
    const proposal = await this.find(userId, proposalId);
    if (proposal.status !== "REJECTED" || !proposal.decision) {
      throw new ConflictException(`This proposal is ${proposal.status}, not rejected`);
    }
    const decidedAt = proposal.decision.decidedAt;
    const steps = (proposal.run.pipelineVersion.definition as unknown as CompiledDefinition).steps;
    const forEachOf = (stepKey: string) => steps.find((s) => s.id === stepKey)?.forEach;

    await this.prisma.client.$transaction(async (tx) => {
      // Holds the run's row, so the worker can't claim the run until this is saved.
      const held = await tx.run.updateMany({ where: { runId: proposal.runId, status: "WAITING_FOR_USER" }, data: { status: "WAITING_FOR_USER" } });
      if (held.count === 0) throw new ConflictException("The run no longer waits for me, so the rejection can't be undone");

      const rows = await tx.step.findMany({ where: { runId: proposal.runId } });
      const gate = rows.find((s) => s.stepId === proposal.stepId);
      const list = gate ? forEachOf(gate.stepKey) : undefined;
      const skippedByIt = rows.filter((s) => s.status === "SKIPPED" && s.error === REJECTED_AT_GATE && s.itemIndex === proposal.itemIndex);
      const otherItem = (s: (typeof rows)[number]) => list !== undefined && s.itemIndex !== proposal.itemIndex && forEachOf(s.stepKey) === list;
      const since = (date: Date | null) => date !== null && date >= decidedAt;
      const moved = rows.find(
        (s) => s !== gate && !skippedByIt.includes(s) && !otherItem(s) && (since(s.startedAt) || since(s.finishedAt)),
      );
      if (moved) throw new ConflictException(`The run went on after the rejection (${moved.stepKey}), so it can't be undone`);

      await tx.step.deleteMany({ where: { stepId: { in: skippedByIt.map((s) => s.stepId) } } });
      await tx.step.update({ where: { stepId: proposal.stepId }, data: { status: "WAITING", output: Prisma.DbNull, finishedAt: null } });
      await tx.decision.delete({ where: { proposalId } });
      await tx.proposal.update({
        where: { proposalId },
        data: { status: "PENDING_REVIEW", finalPayload: Prisma.DbNull, payloadHash: null, approvedNewTargets: [] },
      });
    });
    await this.events.publish(userId, { type: "proposal", proposalId, runId: proposal.runId, status: "PENDING_REVIEW" });
    await this.telegram.decided(proposalId, "↩ Rejection undone in the app: decide there");
    return this.get(userId, proposalId);
  }

  /** Saves the decision unless another one got there first, then queues the run to continue. */
  private async decide(
    proposal: ProposalWithContext,
    change: {
      proposal: Prisma.ProposalUpdateManyMutationInput & { status: "APPROVED" | "REJECTED" };
      decision: Omit<Prisma.DecisionCreateManyInput, "proposalId">;
    },
  ): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.proposal.updateMany({
        where: { proposalId: proposal.proposalId, status: "PENDING_REVIEW" },
        data: change.proposal,
      });
      if (updated.count === 0) throw new ConflictException("This proposal was already decided");
      await tx.decision.create({ data: { ...change.decision, proposalId: proposal.proposalId } });
    });
    await this.events.publish(proposal.userId, {
      type: "proposal",
      proposalId: proposal.proposalId,
      runId: proposal.runId,
      status: change.proposal.status,
    });
    await this.queue.enqueueRun({ runId: proposal.runId, headed: proposal.run.headed });
    // What I approve to be sent becomes a few-shot example of the step that wrote it (README §8).
    if (change.proposal.status === "APPROVED" && proposal.step.type === "gate.act") {
      await this.queue.enqueueLearning(proposal.proposalId);
    }
  }

  /** An edited payload must still be valid input of the step it approves (gate.act) or a selection (gate.review). */
  private validEdit(proposal: ProposalWithContext, payload: Record<string, unknown>): Record<string, unknown> {
    let schema: z.ZodType<Record<string, unknown>> = ReviewSelectionSchema;
    if (proposal.step.type === "gate.act") {
      const definition = proposal.run.pipelineVersion.definition as unknown as CompiledDefinition;
      const type = definition.steps.find((s) => s.id === proposal.stepKey)?.type;
      const step = type ? this.catalog.get(type) : undefined;
      if (!step) throw new ConflictException(`Step "${proposal.stepKey}" is no longer in the catalog`);
      schema = step.input;
    }
    const result = schema.safeParse(payload);
    if (result.success) return result.data;
    throw new BadRequestException({
      message: "The edited payload is not valid",
      errors: result.error.issues.map((issue) => ({ path: ["payload", ...issue.path].join("."), message: issue.message })),
    });
  }

  private async find(userId: string, proposalId: string): Promise<ProposalWithContext> {
    const proposal = await this.prisma.client.proposal.findFirst({ where: { proposalId, userId }, include: PROPOSAL_INCLUDE });
    if (!proposal) throw new NotFoundException();
    return proposal;
  }
}

function assertPending(proposal: ProposalWithContext): void {
  if (proposal.status !== "PENDING_REVIEW") throw new ConflictException(`This proposal is ${proposal.status}, not waiting for a decision`);
}

/** Top-level fields whose value differs: enough for the inbox and for learning from edits (M6). */
function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter((key) => canonicalJson(before[key] ?? null) !== canonicalJson(after[key] ?? null));
}

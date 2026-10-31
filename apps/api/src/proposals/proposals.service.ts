import { payloadHash } from "@ai-me/crypto";
import { type Prisma } from "@ai-me/db";
import { JobQueue } from "@ai-me/queue";
import {
  canonicalJson,
  type ApproveProposalRequest,
  type CompiledDefinition,
  type ProposalStatusName,
  type ProposalView,
} from "@ai-me/shared";
import { StepCatalog } from "@ai-me/steps";
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { z } from "zod";
import { ControlsService } from "../controls/controls.service";
import { PrismaService } from "../database/prisma.service";
import { EventsService } from "../events/events.service";
import { PROPOSAL_INCLUDE, proposalView, type ProposalWithContext } from "./proposal-view";

const ReviewSelectionSchema = z.object({ items: z.array(z.unknown()) }).strict();

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

  async approve(userId: string, proposalId: string, body: ApproveProposalRequest): Promise<ProposalView> {
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
    return this.get(userId, proposalId);
  }

  async reject(userId: string, proposalId: string, reason: string | undefined): Promise<ProposalView> {
    const proposal = await this.find(userId, proposalId);
    assertPending(proposal);
    await this.decide(proposal, { proposal: { status: "REJECTED" }, decision: { kind: "REJECTED", reason: reason ?? null } });
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

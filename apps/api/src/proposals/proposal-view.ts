import { emailSenders, stepTypeIn, type Prisma, type PrismaClient } from "@realentity/storm-db";
import { type ProposalView, type TargetView } from "@realentity/storm-shared";

/** What a proposal view needs besides the proposal: its pipeline, the gate's type, the decision. */
export const PROPOSAL_INCLUDE = {
  run: {
    select: { headed: true, pipelineVersion: { select: { pipelineId: true, definition: true, pipeline: { select: { name: true } } } } },
  },
  step: { select: { type: true } },
  decision: true,
} satisfies Prisma.ProposalInclude;

export type ProposalWithContext = Prisma.ProposalGetPayload<{ include: typeof PROPOSAL_INCLUDE }>;

type Sender = ProposalView["from"];

function stepTypeOf(p: ProposalWithContext): string | null {
  return stepTypeIn(p.run.pipelineVersion.definition, p.stepKey);
}

/** Whom each email.send proposal goes out from (@realentity/storm-db's emailSenders), by proposal. */
export async function proposalSenders(
  prisma: PrismaClient,
  userId: string,
  proposals: ProposalWithContext[],
): Promise<Map<string, Sender>> {
  return emailSenders(
    prisma,
    userId,
    proposals
      .filter((p) => stepTypeOf(p) === "email.send")
      .map((p) => ({
        key: p.proposalId,
        pipelineId: p.run.pipelineVersion.pipelineId,
        definition: p.run.pipelineVersion.definition,
        payload: (p.finalPayload ?? p.originalPayload) as Record<string, unknown>,
      })),
  );
}

export function proposalView(p: ProposalWithContext, from: Sender = null): ProposalView {
  return {
    proposalId: p.proposalId,
    runId: p.runId,
    pipelineId: p.run.pipelineVersion.pipelineId,
    pipelineName: p.run.pipelineVersion.pipeline.name,
    kind: p.step.type === "gate.review" ? "review" : "act",
    stepKey: p.stepKey,
    stepType: stepTypeOf(p),
    itemIndex: p.itemIndex,
    status: p.status,
    target: p.target,
    targets: (p.targets as unknown as TargetView[] | null) ?? [],
    originalPayload: p.originalPayload as Record<string, unknown>,
    finalPayload: (p.finalPayload as Record<string, unknown> | null) ?? null,
    from,
    approvedNewTargets: p.approvedNewTargets,
    reasoning: p.reasoning,
    dateCreated: p.dateCreated.toISOString(),
    decision: p.decision ? { kind: p.decision.kind, reason: p.decision.reason, decidedAt: p.decision.decidedAt.toISOString() } : null,
  };
}

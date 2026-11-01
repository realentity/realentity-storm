import { type Prisma } from "@ai-me/db";
import { type ProposalView, type TargetView } from "@ai-me/shared";

/** What a proposal view needs besides the proposal: its pipeline, the gate's type, the decision. */
export const PROPOSAL_INCLUDE = {
  run: {
    select: { headed: true, pipelineVersion: { select: { pipelineId: true, definition: true, pipeline: { select: { name: true } } } } },
  },
  step: { select: { type: true } },
  decision: true,
} satisfies Prisma.ProposalInclude;

export type ProposalWithContext = Prisma.ProposalGetPayload<{ include: typeof PROPOSAL_INCLUDE }>;

export function proposalView(p: ProposalWithContext): ProposalView {
  return {
    proposalId: p.proposalId,
    runId: p.runId,
    pipelineId: p.run.pipelineVersion.pipelineId,
    pipelineName: p.run.pipelineVersion.pipeline.name,
    kind: p.step.type === "gate.review" ? "review" : "act",
    stepKey: p.stepKey,
    stepType: (p.run.pipelineVersion.definition as { steps?: { id: string; type: string }[] }).steps?.find((s) => s.id === p.stepKey)?.type ?? null,
    itemIndex: p.itemIndex,
    status: p.status,
    target: p.target,
    targets: (p.targets as unknown as TargetView[] | null) ?? [],
    originalPayload: p.originalPayload as Record<string, unknown>,
    finalPayload: (p.finalPayload as Record<string, unknown> | null) ?? null,
    approvedNewTargets: p.approvedNewTargets,
    reasoning: p.reasoning,
    dateCreated: p.dateCreated.toISOString(),
    decision: p.decision ? { kind: p.decision.kind, reason: p.decision.reason, decidedAt: p.decision.decidedAt.toISOString() } : null,
  };
}

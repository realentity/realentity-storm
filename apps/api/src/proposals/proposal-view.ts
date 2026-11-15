import { type Prisma, type PrismaClient } from "@realentity/storm-db";
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

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stepTypeOf(p: ProposalWithContext): string | null {
  return (p.run.pipelineVersion.definition as { steps?: { id: string; type: string }[] }).steps?.find((s) => s.id === p.stepKey)?.type ?? null;
}

/**
 * Whom each email.send proposal goes out from, picked as the worker picks it (mailWho, then the connector): the
 * account the payload names by id, or the one bound to the slot it names (the pipeline's own over its App's), else the
 * default (the one marked, else the oldest). An id or slot whose account is gone: null, as the send would fail.
 */
export async function emailSenders(prisma: PrismaClient, userId: string, proposals: ProposalWithContext[]): Promise<Map<string, Sender>> {
  const senders = new Map<string, Sender>();
  const emails = proposals.filter((p) => stepTypeOf(p) === "email.send");
  if (emails.length === 0) return senders;
  const accounts = await prisma.emailAccount.findMany({
    where: { userId },
    orderBy: [{ isDefault: "desc" }, { dateCreated: "asc" }],
    select: { emailAccountId: true, address: true, label: true },
  });
  const byId = new Map(accounts.map((a) => [a.emailAccountId, a]));
  const slotCache = new Map<string, Record<string, string>>();
  for (const p of emails) {
    const named = ((p.finalPayload ?? p.originalPayload) as Record<string, unknown>).account;
    let id: string | null = null;
    if (typeof named === "string" && named) {
      if (ACCOUNT_ID.test(named)) id = named;
      else {
        const pipelineId = p.run.pipelineVersion.pipelineId;
        if (!slotCache.has(pipelineId)) slotCache.set(pipelineId, await emailSlots(prisma, userId, pipelineId, p.run.pipelineVersion.definition));
        id = slotCache.get(pipelineId)![named] ?? null;
      }
    }
    const account = id ? byId.get(id) : accounts[0];
    senders.set(p.proposalId, account ? { emailAccountId: account.emailAccountId, address: account.address, label: account.label } : null);
  }
  return senders;
}

/** A pipeline's email slots and their accounts: its App's bindings, then its own over them (the worker's loadBindings). */
async function emailSlots(prisma: PrismaClient, userId: string, pipelineId: string, definition: unknown): Promise<Record<string, string>> {
  const { app, refs } = definition as { app?: string; refs?: { appId?: string } };
  const appId =
    refs?.appId ?? (app ? (await prisma.app.findUnique({ where: { userId_name: { userId, name: app } }, select: { appId: true } }))?.appId : undefined);
  const rows = await prisma.binding.findMany({
    where: { emailAccountId: { not: null }, OR: [{ pipelineId }, ...(appId ? [{ appId }] : [])] },
    select: { slot: true, emailAccountId: true, pipelineId: true },
  });
  const slots: Record<string, string> = {};
  for (const row of [...rows.filter((r) => !r.pipelineId), ...rows.filter((r) => r.pipelineId)]) slots[row.slot] = row.emailAccountId!;
  return slots;
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

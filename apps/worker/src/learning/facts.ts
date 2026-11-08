import { type Fact, type Prisma, type PrismaClient } from "@realentity/storm-db";
import { factKey, type CompiledDefinition } from "@realentity/storm-shared";
import { type AgentAction, type FormField } from "@realentity/storm-steps";

/** Facts a form step gets: the most used and newest first, enough for any form. */
const MAX_FACTS = 100;
/** Free text written for one job isn't a fact about me. */
const NOT_FACTS = new Set(["textarea", "file", "checkbox"]);


type ProposalForFacts = Prisma.ProposalGetPayload<{ include: { run: { include: { pipelineVersion: true } } } }>;

/**
 * Facts about me (M15): questions forms ask that only I can answer, and my answers. Written only by my approvals (a
 * form field I filled in or changed at the gate), my answers to a run's questions, and the Profile page; a page or
 * the LLM alone never writes one. Form steps read them before writing anything new.
 */
export class Facts {
  constructor(private readonly prisma: PrismaClient) {}

  /** For a form step's prompt. */
  list(userId: string): Promise<Fact[]> {
    return this.prisma.fact.findMany({ where: { userId }, orderBy: [{ uses: "desc" }, { dateUpdated: "desc" }], take: MAX_FACTS });
  }

  /** A form step proposed these facts' answers. */
  async used(factIds: string[]): Promise<void> {
    if (factIds.length) await this.prisma.fact.updateMany({ where: { factId: { in: factIds } }, data: { uses: { increment: 1 }, lastUsedAt: new Date() } });
  }

  /** My answer to a question, or an answer I approved: the fact for that question, new or updated. */
  save(userId: string, fact: { question: string; answer: string; source: Fact["source"]; site?: string | null; proposalId?: string; runId?: string }): Promise<Fact> {
    const data = {
      question: fact.question.trim(),
      answer: fact.answer.trim(),
      source: fact.source,
      site: fact.site ?? null,
      proposalId: fact.proposalId ?? null,
      runId: fact.runId ?? null,
    };
    const key = factKey(fact.question);
    return this.prisma.fact.upsert({ where: { userId_key: { userId, key } }, create: { userId, key, ...data }, update: data });
  }

  /**
   * The facts an approved form proposal teaches: each short answer (not free text, files or checkboxes) that I filled
   * in or changed at the gate. What a step proposed and I approved unchanged is already in my profile or my facts.
   */
  async fromProposal(proposal: ProposalForFacts): Promise<number> {
    const definition = proposal.run.pipelineVersion.definition as unknown as CompiledDefinition;
    const acting = definition.steps.find((s) => s.id === proposal.stepKey);
    const original = proposal.originalPayload as Record<string, unknown>;
    const approved = (proposal.finalPayload ?? proposal.originalPayload) as Record<string, unknown>;
    const site = hostOf(approved.url);
    const answers: { question: string; answer: string }[] = [];

    if (acting?.type === "browser.fillAndSubmit") {
      const before = new Map(((original.fields ?? []) as FormField[]).map((f) => [f.key, f]));
      for (const field of (approved.fields ?? []) as FormField[]) {
        if (NOT_FACTS.has(field.type) || field.human || typeof field.value !== "string" || !field.value.trim() || !field.label.trim()) continue;
        if (before.get(field.key)?.value !== field.value) answers.push({ question: field.label, answer: field.value });
      }
    } else if (acting?.type === "browser.submit") {
      const before = (original.actions ?? []) as AgentAction[];
      ((approved.actions ?? []) as AgentAction[]).forEach((action, i) => {
        if (action.kind !== "type" || !action.target.name.trim() || !action.value.trim()) return;
        const was = before[i];
        if (!was || was.kind !== "type" || was.value !== action.value) answers.push({ question: action.target.name, answer: action.value });
      });
    }
    for (const answer of answers) {
      await this.save(proposal.userId, { ...answer, source: "FORM", site, proposalId: proposal.proposalId, runId: proposal.runId });
    }
    return answers.length;
  }
}

function hostOf(url: unknown): string | null {
  try {
    return typeof url === "string" ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}

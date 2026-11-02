import { type Prisma, type PrismaClient } from "@ai-me/db";
import { type Embeddings, type LlmUsage } from "@ai-me/llm";
import { WHOLE_REFERENCE, type CompiledDefinition } from "@ai-me/shared";
import { type EmailMessage, type StepCatalog } from "@ai-me/steps";
import { Logger } from "@nestjs/common";
import { sourceOf } from "../runner/run-values";
import { emailBlock } from "../steps/email-block";
import { Facts } from "./facts";

/** Few-shot examples per call: enough for tone and length, few enough to keep prompts small. */
const EXAMPLES_PER_CALL = 3;

export interface ExampleText {
  context: string;
  output: string;
}

/** What the LLM steps get from my decisions (README §8): active rules, and similar approved outputs. */
export interface StepLearning {
  /** ACTIVE rules for this step type (or every step) and this pipeline (or every pipeline). */
  rules(userId: string, stepType: string, pipelineId: string): Promise<string[]>;
  /** My most similar approved outputs of this step type; empty without embeddings. */
  examples(userId: string, stepType: string, context: string, recordUsage: (usage: LlmUsage) => void): Promise<ExampleText[]>;
}

export const NO_LEARNING: StepLearning = {
  rules: () => Promise.resolve([]),
  examples: () => Promise.resolve([]),
};

/**
 * The text an example is matched on: what the step was given. Only steps whose catalog entry `learns` have one.
 * Emails are rendered as the draft step shows them to the LLM (they are untrusted data there too).
 */
export function learningContext(stepType: string, input: Record<string, unknown>): string | null {
  if (stepType === "email.draftReply" || stepType === "email.draftFollowUp") {
    return input.message ? emailBlock(input.message as EmailMessage) : null;
  }
  if (stepType === "llm.generate") {
    const context = input.context === undefined ? "" : `\n<context>\n${asText(input.context)}\n</context>`;
    return `<instruction>${asText(input.instruction)}</instruction>${context}`;
  }
  return null;
}

/** An approved (maybe edited) value of a payload field that an LLM step wrote. */
export interface LearnedField {
  /** The step that wrote it, e.g. "email.draftReply", and its id in the pipeline. */
  stepType: string;
  stepKey: string;
  /** The payload field, e.g. "body". */
  field: string;
  context: string;
  /** What the step wrote, and what I approved. */
  original: string;
  approved: string;
}

type ProposalForLearning = Prisma.ProposalGetPayload<{ include: { step: true; run: { include: { pipelineVersion: true } } } }>;

/**
 * Which fields of an act proposal an LLM step wrote: a field of the acting step that is exactly {{draft.body}},
 * where `draft` is a step whose catalog entry learns `body`. Its item is the proposal's when both steps go over
 * the same list, none when the source has no forEach.
 */
export async function learnedFields(prisma: PrismaClient, catalog: StepCatalog, proposal: ProposalForLearning): Promise<LearnedField[]> {
  if (proposal.step.type !== "gate.act") return [];
  const definition = proposal.run.pipelineVersion.definition as unknown as CompiledDefinition;
  const acting = definition.steps.find((s) => s.id === proposal.stepKey);
  if (!acting) return [];
  const original = proposal.originalPayload as Record<string, unknown>;
  const approved = (proposal.finalPayload ?? proposal.originalPayload) as Record<string, unknown>;

  const fields: LearnedField[] = [];
  for (const [field, template] of Object.entries(acting.with)) {
    const reference = typeof template === "string" ? WHOLE_REFERENCE.exec(template)?.[1]?.trim() : undefined;
    const [stepKey, path, ...deeper] = reference?.split(".") ?? [];
    if (!stepKey || !path || deeper.length > 0) continue;
    const source = definition.steps.find((s) => s.id === stepKey);
    if (!source || catalog.get(source.type)?.learns !== path) continue;
    const sameList = source.forEach !== undefined && acting.forEach !== undefined && sourceOf(source.forEach) === sourceOf(acting.forEach);
    if (source.forEach !== undefined && !sameList) continue;

    const row = await prisma.step.findFirst({
      where: { runId: proposal.runId, stepKey, itemIndex: source.forEach ? proposal.itemIndex : null, status: "DONE" },
    });
    const context = row?.input ? learningContext(source.type, row.input as Record<string, unknown>) : null;
    const value = approved[field];
    if (!context || typeof value !== "string" || !value.trim()) continue;
    fields.push({
      stepType: source.type,
      stepKey,
      field,
      context,
      original: typeof original[field] === "string" ? original[field] : "",
      approved: value,
    });
  }
  return fields;
}

/**
 * Examples (README §8 "Few-shot retrieval"): what I approved becomes an example of its step type, matched by
 * embedding the step's input. Without embeddings (no OPENAI_API_KEY, or OpenAI down) examples are kept without a
 * vector and embedded later (`backfill`).
 */
export class Learning implements StepLearning {
  private readonly logger = new Logger(Learning.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly catalog: StepCatalog,
    private readonly embeddings: Embeddings | null,
  ) {}

  async rules(userId: string, stepType: string, pipelineId: string): Promise<string[]> {
    const rules = await this.prisma.rule.findMany({
      where: {
        userId,
        status: "ACTIVE",
        AND: [{ OR: [{ stepType: null }, { stepType }] }, { OR: [{ pipelineId: null }, { pipelineId }] }],
      },
      orderBy: { dateCreated: "asc" },
    });
    return rules.map((rule) => rule.text);
  }

  async examples(userId: string, stepType: string, context: string, recordUsage: (usage: LlmUsage) => void): Promise<ExampleText[]> {
    if (!this.embeddings) return [];
    const model = this.embeddings.model;
    const stored = await this.prisma.example.count({ where: { userId, stepType, embeddingModel: model } });
    if (stored === 0) return [];
    let vector: number[];
    try {
      const { vectors, usage } = await this.embeddings.embed([context]);
      recordUsage(usage);
      vector = vectors[0]!;
    } catch (error) {
      // Examples help; they are never a reason for a draft to fail.
      this.logger.warn(`Drafting without examples: ${(error as Error).message}`);
      return [];
    }
    return this.prisma.$queryRaw<ExampleText[]>`
      SELECT "context", "output" FROM "Examples"
      WHERE "userId" = ${userId}::uuid AND "stepType" = ${stepType} AND "embeddingModel" = ${model} AND "embedding" IS NOT NULL
      ORDER BY "embedding" <=> ${toVector(vector)}::vector
      LIMIT ${EXAMPLES_PER_CALL}`;
  }

  /** An approved proposal (the `learning` job): its LLM-written fields as examples. Returns how many were added. */
  async fromProposal(proposalId: string): Promise<number> {
    const proposal = await this.prisma.proposal.findUnique({
      where: { proposalId },
      include: { step: true, run: { include: { pipelineVersion: true } }, decision: true },
    });
    if (!proposal?.decision || proposal.decision.kind === "REJECTED" || proposal.run.dryRun) return 0;
    // Form answers I filled in or changed become facts (M15-T1).
    await new Facts(this.prisma).fromProposal(proposal);

    let added = 0;
    for (const learned of await learnedFields(this.prisma, this.catalog, proposal)) {
      const embedded = await this.tryEmbed(learned.context);
      const inserted = await this.prisma.$executeRaw`
        INSERT INTO "Examples" ("exampleId", "userId", "stepType", "pipelineId", "context", "output", "embedding", "embeddingModel", "proposalId")
        VALUES (gen_random_uuid(), ${proposal.userId}::uuid, ${learned.stepType}, ${proposal.run.pipelineVersion.pipelineId}::uuid,
                ${learned.context}, ${learned.approved}, ${embedded ? toVector(embedded) : null}::vector,
                ${embedded ? this.embeddings!.model : null}, ${proposalId}::uuid)
        ON CONFLICT ("proposalId", "stepType") DO NOTHING`;
      added += inserted;
    }
    return added;
  }

  /** Embeds examples without a vector of the current model (added while OpenAI was unavailable, or a new model). */
  async backfill(batchSize = 50): Promise<number> {
    if (!this.embeddings) return 0;
    const model = this.embeddings.model;
    let done = 0;
    for (;;) {
      const pending = await this.prisma.$queryRaw<{ exampleId: string; context: string }[]>`
        SELECT "exampleId", "context" FROM "Examples"
        WHERE "embedding" IS NULL OR "embeddingModel" IS DISTINCT FROM ${model}
        ORDER BY "dateCreated" LIMIT ${batchSize}`;
      if (pending.length === 0) return done;
      const { vectors } = await this.embeddings.embed(pending.map((p) => p.context));
      for (const [i, example] of pending.entries()) {
        await this.prisma.$executeRaw`
          UPDATE "Examples" SET "embedding" = ${toVector(vectors[i])}::vector, "embeddingModel" = ${model}
          WHERE "exampleId" = ${example.exampleId}::uuid`;
      }
      done += pending.length;
    }
  }

  private async tryEmbed(text: string): Promise<number[] | null> {
    if (!this.embeddings) return null;
    try {
      return (await this.embeddings.embed([text])).vectors[0] ?? null;
    } catch (error) {
      this.logger.warn(`Example kept without embedding (embedded later): ${(error as Error).message}`);
      return null;
    }
  }
}

/** pgvector's text form: [0.1,0.2,…]. */
function toVector(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

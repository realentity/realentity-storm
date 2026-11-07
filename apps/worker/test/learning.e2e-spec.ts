import { createPrismaConnection, type Prisma, type PrismaConnection } from "@ai-me/db";
import {
  EMBEDDING_DIMENSIONS,
  emptyUsage,
  ModelRouter,
  type BatchItemResult,
  type BatchRequest,
  type Embeddings,
  type LlmBatches,
  type LlmUsage,
} from "@ai-me/llm";
import { defaultCatalog, PipelineCompiler, type EmailMessage } from "@ai-me/steps";
import { TestEnvironment } from "@ai-me/testing";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type z } from "zod";
import { Learning } from "../src/learning/learning";
import { Reflector, type ReflectionAnswer } from "../src/learning/reflection";
import { RunControls } from "../src/runner/run-controls";
import { emailBlock } from "../src/steps/email-block";
import { createVersion } from "./support/test-steps";

const catalog = defaultCatalog();
const RECRUITER_REPLIES = readFileSync(join(__dirname, "../../../pipelines/recruiter-replies.yaml"), "utf8");

/** Bag of words hashed into 1024 dimensions: texts sharing words are close, as with a real model (cosine). */
class FakeEmbeddings implements Embeddings {
  readonly model = "fake-embedding";
  calls = 0;
  failing = false;

  embed(texts: string[]): Promise<{ vectors: number[][]; usage: LlmUsage }> {
    this.calls++;
    if (this.failing) return Promise.reject(new Error("OpenAI could not be reached"));
    const vectors = texts.map((text) => {
      const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
      for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        let h = 0;
        for (const c of word) h = (h * 31 + c.charCodeAt(0)) % EMBEDDING_DIMENSIONS;
        v[h] += 1;
      }
      return v;
    });
    return Promise.resolve({ vectors, usage: { ...emptyUsage(), models: [this.model], calls: 1, costUsd: 0.0001 } });
  }
}

const email = (i: number, subject: string, text: string): EmailMessage => ({
  uid: i,
  messageId: `<m${i}@acme.test>`,
  threadId: `<m${i}@acme.test>`,
  inReplyTo: null,
  references: [],
  from: `ana${i}@acme.test`,
  fromName: "Ana",
  replyTo: `ana${i}@acme.test`,
  to: ["me@aime.test"],
  cc: [],
  subject,
  date: "2026-10-31T08:00:00.000Z",
  text,
  attachments: [],
});

describe("learning from my decisions (M6)", () => {
  let db: PrismaConnection;
  let userId: string;
  let embeddings: FakeEmbeddings;
  let learning: Learning;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(() => {
    embeddings = new FakeEmbeddings();
    learning = new Learning(db.client, catalog, embeddings);
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.rule.deleteMany();
    await db.client.example.deleteMany();
    await db.client.reflection.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  /**
   * What a run of the recruiter replies pipeline leaves behind once I decided on item 1: the draft step's input and
   * output, the gate, and the send proposal with my decision.
   */
  async function decided(
    kind: "APPROVED" | "EDITED" | "REJECTED",
    options: { message?: EmailMessage; draft?: string; approved?: string; reason?: string; dryRun?: boolean } = {},
  ) {
    const versionId = await createVersion(db.client, userId, RECRUITER_REPLIES, new PipelineCompiler(catalog));
    const version = await db.client.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId: versionId } });
    const message = options.message ?? email(1, "Senior .NET role", "We have a Senior .NET role in Sofia, remote friendly.");
    const draft = options.draft ?? "I hope this finds you well. Thank you for reaching out about the role.";
    const run = await db.client.run.create({
      data: { userId, pipelineVersionId: versionId, trigger: "schedule", status: "RUNNING", dryRun: options.dryRun ?? false },
    });
    await db.client.step.create({
      data: {
        runId: run.runId,
        stepKey: "draft",
        itemIndex: 1,
        type: "email.draftReply",
        status: "DONE",
        input: { message, instruction: "Reply briefly" },
        output: { subject: "Re: x", body: draft, language: "en" },
      },
    });
    const gate = await db.client.step.create({
      data: { runId: run.runId, stepKey: "sendGate", itemIndex: 1, type: "gate.act", status: "DONE" },
    });
    const payload = { to: message.from, subject: `Re: ${message.subject}`, body: draft, inReplyTo: message.messageId, references: [] };
    const final = kind === "REJECTED" ? null : { ...payload, body: options.approved ?? draft };
    const proposal = await db.client.proposal.create({
      data: {
        userId,
        runId: run.runId,
        stepId: gate.stepId,
        stepKey: "send",
        itemIndex: 1,
        status: kind === "REJECTED" ? "REJECTED" : "DONE",
        target: message.from,
        originalPayload: payload,
        finalPayload: final ?? undefined,
        decision: {
          create: {
            kind,
            diff: kind === "EDITED" ? { changed: ["body"] } : undefined,
            reason: options.reason ?? null,
          },
        },
      },
    });
    return { proposalId: proposal.proposalId, pipelineId: version.pipelineId, message };
  }

  const examples = () =>
    db.client.$queryRaw<{ stepType: string; context: string; output: string; embedded: boolean; embeddingModel: string | null }[]>`
      SELECT "stepType", "context", "output", "embedding" IS NOT NULL AS embedded, "embeddingModel" FROM "Examples"`;

  // M6-I1
  describe("examples from approved proposals", () => {
    it("an edited reply becomes an example of the draft step: the email as context, my edit as output, embedded", async () => {
      const { proposalId, message } = await decided("EDITED", { approved: "Hi Ana, thanks! Happy to talk." });
      await expect(learning.fromProposal(proposalId)).resolves.toBe(1);
      expect(await examples()).toEqual([
        {
          stepType: "email.draftReply",
          context: emailBlock(message),
          output: "Hi Ana, thanks! Happy to talk.",
          embedded: true,
          embeddingModel: "fake-embedding",
        },
      ]);
      // A retried job adds nothing.
      await expect(learning.fromProposal(proposalId)).resolves.toBe(0);
    });

    it("approved as drafted counts too; rejected and dry-run proposals don't", async () => {
      const approved = await decided("APPROVED");
      const rejected = await decided("REJECTED", { reason: "Not interested" });
      const dry = await decided("EDITED", { approved: "Edited", dryRun: true });
      await expect(learning.fromProposal(approved.proposalId)).resolves.toBe(1);
      await expect(learning.fromProposal(rejected.proposalId)).resolves.toBe(0);
      await expect(learning.fromProposal(dry.proposalId)).resolves.toBe(0);
      expect((await examples()).map((e) => e.output)).toEqual(["I hope this finds you well. Thank you for reaching out about the role."]);
    });

    it("without embeddings the example is kept, and embedded later", async () => {
      embeddings.failing = true;
      const { proposalId } = await decided("EDITED", { approved: "Thanks!" });
      await expect(learning.fromProposal(proposalId)).resolves.toBe(1);
      expect(await examples()).toMatchObject([{ embedded: false, embeddingModel: null }]);

      embeddings.failing = false;
      await expect(learning.backfill()).resolves.toBe(1);
      expect(await examples()).toMatchObject([{ embedded: true, embeddingModel: "fake-embedding" }]);
      await expect(learning.backfill()).resolves.toBe(0);
    });
  });

  // M6-I2
  describe("retrieval", () => {
    async function add(stepType: string, context: string, output: string, model = embeddings.model) {
      const [vector] = (await embeddings.embed([context])).vectors;
      await db.client.$executeRaw`
        INSERT INTO "Examples" ("exampleId", "userId", "stepType", "context", "output", "embedding", "embeddingModel")
        VALUES (gen_random_uuid(), ${userId}::uuid, ${stepType}, ${context}, ${output}, ${`[${vector.join(",")}]`}::vector, ${model})`;
    }

    it("returns my most similar approved outputs of the same step type only, closest first", async () => {
      await add("email.draftReply", "Senior .NET developer role in Sofia remote", "net-sofia");
      await add("email.draftReply", "Frontend React contract in Berlin", "react-berlin");
      await add("email.draftReply", "Invoice for consulting hours", "invoice");
      await add("email.draftReply", "NET developer role", "net-short");
      await add("llm.generate", "Senior .NET developer role in Sofia remote", "other-step");
      await add("email.draftReply", "Senior .NET developer role in Sofia remote", "old-model", "another-model");

      const usage: LlmUsage[] = [];
      const found = await learning.examples(userId, "email.draftReply", "A Senior .NET developer role, Sofia", (u) => usage.push(u));
      // The third is one of the unrelated ones: at most three, never another step type or model.
      expect(found.map((e) => e.output).slice(0, 2)).toEqual(["net-sofia", "net-short"]);
      expect(found).toHaveLength(3);
      expect(found.map((e) => e.output)).not.toContain("other-step");
      expect(found.map((e) => e.output)).not.toContain("old-model");
      expect(usage).toHaveLength(1);
    });

    it("no examples of that step type: no embedding call; embeddings down: none, without failing the draft", async () => {
      await expect(learning.examples(userId, "email.draftReply", "anything", () => undefined)).resolves.toEqual([]);
      expect(embeddings.calls).toBe(0);

      await add("email.draftReply", "Senior .NET role", "net");
      embeddings.failing = true;
      await expect(learning.examples(userId, "email.draftReply", "Senior .NET role", () => undefined)).resolves.toEqual([]);
      await expect(new Learning(db.client, catalog, null).examples(userId, "email.draftReply", "x", () => undefined)).resolves.toEqual([]);
    });
  });

  // M6-I3
  it("only ACTIVE rules are injected; a step type's and global ones; pipeline-scoped ones only into that pipeline", async () => {
    const mine = (await db.client.pipeline.create({ data: { userId, name: "Mine" } })).pipelineId;
    const other = (await db.client.pipeline.create({ data: { userId, name: "Other" } })).pipelineId;
    const rule = (text: string, data: Partial<Prisma.RuleUncheckedCreateInput>) =>
      db.client.rule.create({ data: { userId, text, status: "ACTIVE", stepType: "email.draftReply", ...data } });
    await rule("global", { stepType: null });
    await rule("drafts", {});
    await rule("drafts in mine", { pipelineId: mine });
    await rule("drafts in other", { pipelineId: other });
    await rule("generate", { stepType: "llm.generate" });
    await rule("suggested", { status: "SUGGESTED" });
    await rule("disabled", { status: "DISABLED" });

    await expect(learning.rules(userId, "email.draftReply", mine)).resolves.toEqual(["global", "drafts", "drafts in mine"]);
    await expect(learning.rules(userId, "llm.generate", other)).resolves.toEqual(["global", "generate"]);
  });

  // M6-T5, M6-U1
  describe("reflection", () => {
    class FakeBatches implements LlmBatches {
      submitted: BatchRequest<z.ZodObject>[] = [];
      done = false;
      answer: BatchItemResult<unknown> | null = null;

      submit<S extends z.ZodObject>(requests: BatchRequest<S>[]): Promise<string> {
        this.submitted.push(...(requests as unknown as BatchRequest<z.ZodObject>[]));
        return Promise.resolve("msgbatch_1");
      }
      ended(): Promise<boolean> {
        return Promise.resolve(this.done);
      }
      results<S extends z.ZodObject>(): Promise<BatchItemResult<z.infer<S>>[]> {
        return Promise.resolve(this.answer ? [this.answer as BatchItemResult<z.infer<S>>] : []);
      }
    }

    let batches: FakeBatches;
    let polls: string[];
    const reflector = (budget?: number) =>
      new Reflector(
        db.client,
        catalog,
        batches,
        new ModelRouter(() => Promise.resolve(null)),
        new RunControls(db.client, { monthlyBudgetUsd: budget }),
        (reflectionId) => (polls.push(reflectionId), Promise.resolve()),
      );

    beforeEach(() => {
      batches = new FakeBatches();
      polls = [];
    });

    const ok = (output: ReflectionAnswer): BatchItemResult<unknown> => ({
      customId: "x",
      ok: true,
      output,
      usage: { ...emptyUsage(), models: ["claude-opus-5-5"], calls: 1, costUsd: 0.05 },
    });

    it("sends my edits and rejections (not approvals as drafted) to Opus as a batch, then polls it", async () => {
      for (let i = 0; i < 3; i++) await decided("EDITED", { approved: `Thank you for reaching out about the role. (${i})` });
      await decided("REJECTED", { reason: "Agency, not a direct client" });
      await decided("APPROVED");

      const id = await reflector().submit(userId);
      expect(id).not.toBeNull();
      expect(polls).toEqual([id]);
      const reflection = await db.client.reflection.findUniqueOrThrow({ where: { reflectionId: id! } });
      expect(reflection).toMatchObject({ status: "SUBMITTED", batchId: "msgbatch_1", decisions: 5 });

      const [request] = batches.submitted;
      expect(request?.customId).toBe(id);
      expect(request?.request.choice).toEqual({ model: "claude-opus-5-5", effort: "high" });
      const prompt = request.request.prompt;
      expect(prompt.match(/<decision kind="EDITED"/g)).toHaveLength(3);
      expect(prompt).toContain('<decision kind="REJECTED"');
      expect(prompt).toContain("My reason: Agency, not a direct client");
      expect(prompt).toContain("<proposed>\nI hope this finds you well.");
      expect(prompt).toContain("<approved>\nThank you for reaching out about the role. (0)");
      // The pipeline is one of several of that name in this file: " (n)" since M39-T1.
      expect(prompt).toMatch(/Approved without changes in this period: Recruiter and client replies( \(\d+\))?: 1\./);
      // One at a time: a second request while one is running starts nothing.
      await expect(reflector().submit(userId)).resolves.toBeNull();
    });

    it("nothing to learn from (no decisions, or only approvals as drafted), or over budget: no batch", async () => {
      await expect(reflector().submit(userId)).resolves.toBeNull();
      await decided("APPROVED");
      await expect(reflector().submit(userId)).resolves.toBeNull();
      await decided("EDITED", { approved: "Short." });
      await db.client.step.updateMany({ where: { type: "email.draftReply" }, data: { llmUsage: { costUsd: 6 }, startedAt: new Date() } });
      await expect(reflector(5).submit(userId)).resolves.toBeNull();
      expect(batches.submitted).toEqual([]);
    });

    it("saves what it suggests as SUGGESTED only, after checking step types, pipelines and duplicates", async () => {
      const { pipelineId } = await decided("EDITED", { approved: "Thanks!" });
      await db.client.rule.create({ data: { userId, text: "Keep replies short.", status: "ACTIVE" } });
      const id = (await reflector().submit(userId))!;

      await reflector().check(id);
      expect(polls).toEqual([id, id]); // not ended yet: checked again later
      batches.done = true;
      batches.answer = ok({
        rules: [
          { stepType: "email.draftReply", pipelineId: null, text: "Drop 'I hope this finds you well'.", rationale: "Removed in 3 edits" },
          { stepType: "email.draftReply", pipelineId, text: "Mention remote work first.", rationale: "x" },
          { stepType: "browser.click", pipelineId: null, text: "Unknown step type.", rationale: "x" },
          { stepType: null, pipelineId: "00000000-0000-4000-8000-000000000000", text: "Someone else's pipeline.", rationale: "x" },
          { stepType: null, pipelineId: null, text: "keep replies short", rationale: "a duplicate" },
        ],
        pipelineSuggestions: [
          { pipelineId, text: "Skip agency recruiters in triage.", rationale: "Rejected 4 agencies" },
          { pipelineId: "00000000-0000-4000-8000-000000000000", text: "Not mine.", rationale: "x" },
        ],
      });
      await reflector().check(id);

      const rules = await db.client.rule.findMany({ where: { source: `reflection:${id}` }, orderBy: { text: "asc" } });
      expect(rules.map((r) => [r.text, r.status, r.pipelineId])).toEqual([
        ["Drop 'I hope this finds you well'.", "SUGGESTED", null],
        ["Mention remote work first.", "SUGGESTED", pipelineId],
      ]);
      expect(await db.client.rule.count({ where: { status: "ACTIVE" } })).toBe(1);
      const suggestions = await db.client.pipelineSuggestion.findMany();
      expect(suggestions.map((s) => [s.text, s.status])).toEqual([["Skip agency recruiters in triage.", "OPEN"]]);
      expect(await db.client.reflection.findUniqueOrThrow({ where: { reflectionId: id } })).toMatchObject({
        status: "DONE",
        llmUsage: { costUsd: 0.05 },
      });

      // The cost counts towards the budget, and the next reflection starts where this one ended.
      expect(await new RunControls(db.client).monthlySpendUsd(userId)).toBeCloseTo(0.05, 6);
      await expect(reflector().submit(userId)).resolves.toBeNull();
    });

    it("a failed or invalid answer marks the reflection FAILED and saves nothing", async () => {
      await decided("EDITED", { approved: "Thanks!" });
      const id = (await reflector().submit(userId))!;
      batches.done = true;
      batches.answer = { customId: id, ok: false, error: "The model's answer did not match the expected format", usage: emptyUsage() };
      await reflector().check(id);
      expect(await db.client.reflection.findUniqueOrThrow({ where: { reflectionId: id } })).toMatchObject({
        status: "FAILED",
        error: "The model's answer did not match the expected format",
      });
      expect(await db.client.rule.count()).toBe(0);
    });
  });
});

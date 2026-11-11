import { applyProposal, createPrismaConnection, undoChange, type Prisma, type PrismaConnection, type Proposal } from "@realentity/storm-db";
import { emptyUsage, ModelRouter, type LlmClient, type LlmUsage, type StructuredRequest } from "@realentity/storm-llm";
import { PipelineCompiler, type TopicProposal } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type z } from "zod";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry, NO_ATTENTION } from "../src/runner/step-executor";
import { TopicApplyStep } from "../src/steps/topic-memory-steps";
import { TopicTidyStep } from "../src/steps/topic-tidy-step";
import { catalog, createVersion } from "./support/test-steps";

type Answer = { merges: { facts: string[]; about: string; statement: string; why: string }[]; retire: { fact: string; why: string }[] };

/** The writing model, answering `answer(prompt)`. */
class TidyLlm implements LlmClient {
  requests: StructuredRequest<z.ZodObject>[] = [];
  constructor(private readonly answer: (prompt: string) => Answer) {}
  structured<S extends z.ZodObject>(request: StructuredRequest<S>): Promise<{ output: z.infer<S>; usage: LlmUsage }> {
    this.requests.push(request);
    return Promise.resolve({ output: request.schema.parse(this.answer(request.prompt)), usage: { ...emptyUsage(), costUsd: 0.01 } });
  }
}

const router = new ModelRouter(() => Promise.resolve(null));
const TIDY = readFileSync(join(__dirname, "../../../pipelines/topic-tidy.yaml"), "utf8");
/** A fact long enough that eight of them don't fit in a draft (six do). */
const LONG = "Routine detail of the weekly meeting. ".repeat(23).trim();

// M44-T8: a weekly tidy-up of a topic's facts, proposed at a gate, applied only as approved, undone like any change
describe("topic.tidy", () => {
  let db: PrismaConnection;
  let userId: string;
  let orion: string;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(async () => {
    orion = (await db.client.topic.create({ data: { userId, name: "Orion", description: "The customer portal rebuild" } })).topicId;
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.topic.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  const fact = (about: string, statement: string, extra: Partial<Prisma.TopicFactUncheckedCreateInput> = {}) =>
    db.client.topicFact.create({
      data: {
        userId,
        topicId: orion,
        about,
        statement,
        source: "EMAIL",
        sourceId: `<${about}@client.example>`,
        sourceLabel: "maria@client.example: Plan",
        sourceDate: new Date("2026-11-01T09:00:00Z"),
        ...extra,
      },
    });
  /** Eight long facts, Note 0 to Note 7: F1 to F8 in the prompt (by `about`). */
  const overflowing = async () => {
    for (let i = 0; i < 8; i++) await fact(`Note ${i}`, `${LONG} ${i}`);
  };
  const facts = async () =>
    (await db.client.topicFact.findMany({ where: { topicId: orion }, orderBy: [{ about: "asc" }, { dateCreated: "asc" }] })).map((f) => [
      f.about,
      f.status,
    ]);
  const runnerWith = (llm: LlmClient) =>
    new PipelineRunner(
      db.client,
      catalog,
      new ExecutorRegistry([new TopicTidyStep(llm, router, undefined, db.client), new TopicApplyStep(db.client)]),
    );
  async function approve(proposal: Proposal, items: unknown[]) {
    await db.client.proposal.update({
      where: { proposalId: proposal.proposalId },
      data: { status: "APPROVED", finalPayload: { items } as Prisma.InputJsonValue },
    });
  }

  it("M44-I3: a topic over the room gets merges and retirements; only what the user picked is done; Undo brings the facts back", async () => {
    await overflowing();
    // A topic whose facts fit isn't read.
    const other = await db.client.topic.create({ data: { userId, name: "Billing", description: "" } });
    await db.client.topicFact.create({
      data: {
        userId,
        topicId: other.topicId,
        about: "Terms",
        statement: "30 days",
        source: "USER",
        sourceLabel: "you",
        sourceDate: new Date(),
      },
    });
    const llm = new TidyLlm(() => ({
      merges: [
        { facts: ["F1", "F2"], about: "Weekly meeting", statement: "Notes 0 and 1, said once", why: "both about the weekly meeting" },
        // Unknown facts, and one fact in two proposals: dropped.
        { facts: ["F99", "F98"], about: "Nothing", statement: "x", why: "x" },
      ],
      retire: [
        { fact: "F3", why: "the meeting is past" },
        { fact: "F1", why: "merged already" },
      ],
    }));
    const runner = runnerWith(llm);
    const version = await createVersion(db.client, userId, TIDY, new PipelineCompiler(catalog));
    const runId = await runner.start(version, { trigger: "manual" });
    await expect(runner.advance(runId)).resolves.toBe("WAITING_FOR_USER");

    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.choice.model).toBe("claude-sonnet-5-5");
    expect(llm.requests[0]?.prompt).toContain("Current facts (8; a draft has room for about 6):");
    expect(llm.requests[0]?.prompt).toContain("- F3: Note 2: Routine detail");
    expect(llm.requests[0]?.prompt).not.toContain("Billing");

    const [review] = await db.client.proposal.findMany({ where: { runId } });
    expect(review?.target).toBe("Tidy-up: 2 proposals for Orion");
    const offered = (review.originalPayload as { items: TopicProposal[] }).items;
    expect(offered.map((p) => [p.kind, p.title, p.why])).toEqual([
      ["merge", 'Orion: merge 2 into "Weekly meeting: Notes 0 and 1, said once"', "both about the weekly meeting"],
      ["retire", expect.stringMatching(/^Orion: retire "Note 2: Routine detail of/), "the meeting is past"],
    ]);
    // Nothing done before the user decides.
    expect((await facts()).every(([, status]) => status === "CURRENT")).toBe(true);

    await approve(review, [offered[0]]);
    await expect(runner.advance(runId)).resolves.toBe("DONE");
    const merged = await db.client.topicFact.findFirstOrThrow({ where: { topicId: orion, about: "Weekly meeting" } });
    expect(merged).toMatchObject({ statement: "Notes 0 and 1, said once", status: "CURRENT", source: "USER", pinned: false, runId });
    expect(merged.sourceLabel).toBe("you, merging 2 facts (maria@client.example: Plan)");
    const notes = await db.client.topicFact.findMany({
      where: { topicId: orion, about: { in: ["Note 0", "Note 1", "Note 2"] } },
      orderBy: { about: "asc" },
    });
    expect(notes.map((f) => [f.about, f.status, f.supersededById])).toEqual([
      ["Note 0", "SUPERSEDED", merged.topicFactId],
      ["Note 1", "SUPERSEDED", merged.topicFactId],
      ["Note 2", "CURRENT", null],
    ]);
    // Its cost is the topic's.
    expect((await db.client.topicCost.findMany({ where: { topicId: orion } })).map((c) => c.source)).toEqual(["topic.tidy"]);

    const [change] = await db.client.topicChange.findMany({ where: { topicId: orion } });
    expect(change).toMatchObject({ kind: "APPLY", summary: offered[0].title, runId });
    await undoChange(db.client, userId, change.topicChangeId);
    expect(await db.client.topicFact.count({ where: { about: "Weekly meeting" } })).toBe(0);
    expect((await facts()).every(([, status]) => status === "CURRENT")).toBe(true);

    // Next week: the retirement the user left out isn't proposed again; the merge, undone, can be.
    const next = await runner.start(version, { trigger: "manual" });
    await expect(runner.advance(next)).resolves.toBe("WAITING_FOR_USER");
    const [again] = await db.client.proposal.findMany({ where: { runId: next } });
    expect((again.originalPayload as { items: TopicProposal[] }).items.map((p) => p.kind)).toEqual(["merge"]);
  });

  it("a topic named is tidied though its facts fit; disputes aren't shown; a dry run records no cost", async () => {
    await fact("Launch date", "March");
    await fact("Launch", "In March 2027");
    await fact("Database", "MySQL", { status: "DISPUTED" });
    const llm = new TidyLlm(() => ({ merges: [], retire: [] }));
    const step = new TopicTidyStep(llm, router, undefined, db.client);
    const context = {
      runId: randomUUID(),
      userId,
      pipelineId: randomUUID(),
      stepId: "tidy",
      stepKey: "tidy",
      itemIndex: null,
      dryRun: true,
      recordUsage: () => undefined,
      attention: NO_ATTENTION,
    };
    expect(await step.execute({}, context)).toEqual({ proposals: [], title: "Nothing to tidy", topics: [] });
    expect(llm.requests).toHaveLength(0);

    expect(await step.execute({ topics: ["Orion"] }, context)).toEqual({
      proposals: [],
      title: "Nothing to tidy",
      topics: [{ topic: "Orion", facts: 2, fit: 2 }],
    });
    expect(llm.requests[0]?.prompt).toContain("Launch: In March 2027");
    expect(llm.requests[0]?.prompt).not.toContain("MySQL");
    expect(await db.client.topicCost.count()).toBe(0);
  });

  it("a tidy-up of facts that changed since is skipped; a retirement keeps the fact as history; a user's fact merged stays pinned", async () => {
    const kickoff = await fact("Kickoff", "3 March 2026");
    const owner = await fact("API owner", "Ivan", { pinned: true, source: "USER", sourceLabel: "you" });
    const lead = await fact("API lead", "Ivan Petrov");
    const base = {
      topicId: orion,
      quote: "",
      source: { kind: "tidy" as const, messageId: "tidy", from: "Storm", subject: "tidy-up", date: new Date().toISOString() },
    };
    const retire = {
      ...base,
      kind: "retire" as const,
      title: 'Orion: retire "Kickoff: 3 March 2026"',
      about: "Kickoff",
      statement: "3 March 2026",
      replaces: { topicFactId: kickoff.topicFactId, statement: "3 March 2026" },
    };
    const merge = {
      ...base,
      kind: "merge" as const,
      title: 'Orion: merge 2 into "API owner: Ivan Petrov"',
      about: "API owner",
      statement: "Ivan Petrov",
      replaces: null,
      merges: [owner, lead].map((f) => ({ topicFactId: f.topicFactId, statement: f.statement })),
    };

    // Edited since it was proposed: the user's word wins.
    await db.client.topicFact.update({ where: { topicFactId: kickoff.topicFactId }, data: { statement: "10 March 2026" } });
    await expect(applyProposal(db.client, userId, retire, null)).resolves.toEqual({
      applied: false,
      reason: "a fact it tidies has changed since",
    });
    await db.client.topicFact.update({ where: { topicFactId: kickoff.topicFactId }, data: { statement: "3 March 2026" } });
    await expect(applyProposal(db.client, userId, retire, null)).resolves.toMatchObject({ applied: true });
    expect(await db.client.topicFact.findUniqueOrThrow({ where: { topicFactId: kickoff.topicFactId } })).toMatchObject({
      status: "SUPERSEDED",
      supersededById: null,
    });

    const outcome = await applyProposal(db.client, userId, merge, null);
    expect(outcome).toMatchObject({ applied: true });
    const merged = await db.client.topicFact.findUniqueOrThrow({
      where: { topicFactId: (outcome as { topicFactId: string }).topicFactId },
    });
    expect(merged).toMatchObject({ about: "API owner", statement: "Ivan Petrov", pinned: true, source: "USER", status: "CURRENT" });
    expect(merged.sourceLabel).toBe("you, merging 2 facts (maria@client.example: Plan; yours)");
    // Done once: the facts are no longer current.
    await expect(applyProposal(db.client, userId, merge, null)).resolves.toEqual({
      applied: false,
      reason: "a fact it tidies has changed since",
    });
  });
});

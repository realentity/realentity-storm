import { createPrismaConnection, type PrismaConnection } from "@ai-me/db";
import { QUEUES } from "@ai-me/queue";
import { type LearningView, type RuleView } from "@ai-me/shared";
import { TestEnvironment } from "@ai-me/testing";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

// M6-T6: the Rules page
describe("rules, suggestions and reflection", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;
  let userId: string;
  let pipelineId: string;

  beforeAll(async () => {
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(async () => {
    pipelineId = (await db.client.pipeline.create({ data: { userId, name: "Recruiter replies" } })).pipelineId;
  });

  afterEach(async () => {
    await db.client.rule.deleteMany();
    await db.client.reflection.deleteMany();
    await db.client.example.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.$executeRaw`DELETE FROM pgboss.job`;
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  const view = async () => (await agent.get("/api/learning").expect(200)).body as LearningView;

  it("a rule I write is active at once; scoped to a step type and pipeline of mine", async () => {
    const rule = (
      await agent.post("/api/rules").send({ text: "Keep replies under 80 words.", stepType: "email.draftReply", pipelineId }).expect(201)
    ).body as RuleView;
    expect(rule).toMatchObject({ status: "ACTIVE", source: "manual", stepType: "email.draftReply", pipelineName: "Recruiter replies" });

    await agent.post("/api/rules").send({ text: "x" }).expect(400);
    await agent.post("/api/rules").send({ text: "Valid text", stepType: "browser.click" }).expect(400);
    await agent.post("/api/rules").send({ text: "Valid text", pipelineId: "00000000-0000-4000-8000-000000000000" }).expect(400);
    await agent.post("/api/rules").send({ text: "Global rule" }).expect(201);
    expect((await view()).rules.map((r) => [r.text, r.stepType, r.pipelineId])).toEqual([
      ["Global rule", null, null],
      ["Keep replies under 80 words.", "email.draftReply", pipelineId],
    ]);
  });

  it("a suggested rule becomes active only when I approve it; I can edit, disable and delete it", async () => {
    const { ruleId } = await db.client.rule.create({
      data: {
        userId,
        text: "Drop 'I hope this finds you well'.",
        rationale: "Removed in 6 edits",
        status: "SUGGESTED",
        source: "reflection:r",
      },
    });
    expect((await view()).rules).toEqual([expect.objectContaining({ ruleId, status: "SUGGESTED", rationale: "Removed in 6 edits" })]);

    const edited = (
      await agent
        .patch(`/api/rules/${ruleId}`)
        .send({ text: "Never open with 'I hope this finds you well'.", status: "ACTIVE" })
        .expect(200)
    ).body as RuleView;
    expect(edited).toMatchObject({ status: "ACTIVE", text: "Never open with 'I hope this finds you well'.", source: "reflection:r" });
    await agent.patch(`/api/rules/${ruleId}`).send({ status: "DISABLED" }).expect(200);
    await agent.patch(`/api/rules/${ruleId}`).send({}).expect(400);
    await agent.patch(`/api/rules/${ruleId}`).send({ status: "WHATEVER" }).expect(400);
    await agent.delete(`/api/rules/${ruleId}`).expect(204);
    await agent.delete(`/api/rules/${ruleId}`).expect(404);
  });

  it("lists open pipeline suggestions; dismissing one hides it", async () => {
    const { suggestionId } = await db.client.pipelineSuggestion.create({
      data: { userId, pipelineId, text: "Skip agency recruiters in triage.", rationale: "Rejected 4 agencies" },
    });
    expect((await view()).suggestions).toEqual([
      expect.objectContaining({
        suggestionId,
        pipelineName: "Recruiter replies",
        text: "Skip agency recruiters in triage.",
        status: "OPEN",
      }),
    ]);
    await agent.patch(`/api/suggestions/${suggestionId}`).send({ status: "DISMISSED" }).expect(204);
    expect((await view()).suggestions).toEqual([]);
    await agent.patch("/api/suggestions/00000000-0000-4000-8000-000000000000").send({ status: "DISMISSED" }).expect(404);
  });

  it("shows recent reflections with their cost, and the examples per step type", async () => {
    await db.client.reflection.create({
      data: {
        userId,
        since: new Date("2026-10-01"),
        until: new Date("2026-10-31"),
        decisions: 12,
        status: "DONE",
        llmUsage: { costUsd: 0.04 },
      },
    });
    await db.client.$executeRaw`
      INSERT INTO "Examples" ("exampleId", "userId", "stepType", "context", "output")
      VALUES (gen_random_uuid(), ${userId}::uuid, 'email.draftReply', 'c', 'o'), (gen_random_uuid(), ${userId}::uuid, 'email.draftReply', 'c', 'o')`;
    const learning = await view();
    expect(learning.reflections).toEqual([expect.objectContaining({ status: "DONE", decisions: 12, costUsd: 0.04 })]);
    expect(learning.examples).toEqual([{ stepType: "email.draftReply", count: 2 }]);
    expect(typeof learning.embeddings).toBe("boolean");
  });

  it("asks the worker for a reflection now", async () => {
    await agent.post("/api/reflection").expect(202);
    const jobs = await db.client.$queryRaw<
      { name: string; data: unknown }[]
    >`SELECT name, data FROM pgboss.job WHERE name = ${QUEUES.reflection}`;
    expect(jobs).toEqual([{ name: QUEUES.reflection, data: { userId } }]);
  });
});

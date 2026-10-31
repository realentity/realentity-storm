import { createPrismaConnection, type PrismaConnection } from "@ai-me/db";
import { type CompilePipelineResponse, type PipelineDetailView, type PipelineVersionView } from "@ai-me/shared";
import { randomUUID } from "node:crypto";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

const V1 = `
name: Morning digest
trigger: { schedule: "0 8 * * 1-5" }
steps:
  - id: summary
    type: llm.generate
    with: { instruction: "Summarize my day" }
  - id: tell
    type: notify.telegram
    with: { text: "{{summary.text}}" }
`;

const V2 = V1.replace("Summarize my day", "Summarize my day in 3 bullets");

describe("pipelines", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;

  beforeAll(async () => {
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
  });

  afterAll(async () => {
    await db.client.pipeline.deleteMany();
    await db.close();
    await api.close();
  });

  it("compiles without saving: errors for a broken source", async () => {
    const response = await agent
      .post("/api/pipelines/compile")
      .send({ source: V1.replace("{{summary.text}}", "{{summary.body}}") })
      .expect(200);
    const body = response.body as CompilePipelineResponse;
    expect(body.result.ok).toBe(false);
    expect(JSON.stringify(body.result)).toMatch(/has no field \\"body\\"/);
    await expect(db.client.pipeline.count()).resolves.toBe(0);
  });

  it("compiles without saving: plan and policy for a valid source", async () => {
    const body = (await agent.post("/api/pipelines/compile").send({ source: V1 }).expect(200)).body as CompilePipelineResponse;
    expect(body.result).toMatchObject({ ok: true, definition: { name: "Morning digest", trigger: { tz: "Europe/Sofia" } } });
  });

  it("refuses to save a source that doesn't compile", async () => {
    const response = await agent.post("/api/pipelines").send({ source: "name: x\nsteps: []" }).expect(400);
    expect(response.body).toMatchObject({ message: "The pipeline doesn't compile" });
  });

  // M3-E4 (api part)
  it("saves v1, then v2 with a change summary and a diff in preview", async () => {
    const created = (await agent.post("/api/pipelines").send({ source: V1 }).expect(201)).body as PipelineDetailView;
    expect(created).toMatchObject({
      name: "Morning digest",
      enabled: false,
      currentVersion: 1,
      versions: [{ version: 1, changeSummary: null }],
    });

    const preview = (await agent.post("/api/pipelines/compile").send({ source: V2, pipelineId: created.pipelineId }).expect(200))
      .body as CompilePipelineResponse;
    expect(preview.diff?.changes).toEqual([
      expect.objectContaining({
        kind: "step-changed",
        stepId: "summary",
        field: "with.instruction",
        after: "Summarize my day in 3 bullets",
      }),
    ]);

    const updated = (await agent.post(`/api/pipelines/${created.pipelineId}/versions`).send({ source: V2 }).expect(201))
      .body as PipelineDetailView;
    expect(updated.currentVersion).toBe(2);
    expect(updated.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(updated.versions[0]?.changeSummary).toMatch(/^step summary: with\.instruction/);

    const v1 = (await agent.get(`/api/pipelines/${created.pipelineId}/versions/1`).expect(200)).body as PipelineVersionView;
    expect(v1.definition.steps[0]?.with).toEqual({ instruction: "Summarize my day" });

    await agent.post(`/api/pipelines/${created.pipelineId}/versions`).send({ source: V2 }).expect(422);
    const list = (await agent.get("/api/pipelines").expect(200)).body as { name: string; currentVersion: number }[];
    expect(list).toEqual([expect.objectContaining({ name: "Morning digest", currentVersion: 2 })]);
  });

  it("stores the compiled definition and policy", async () => {
    const created = (
      await agent
        .post("/api/pipelines")
        .send({ source: V1.replace("Morning digest", "Stored") })
        .expect(201)
    ).body as PipelineDetailView;
    const row = await db.client.pipelineVersion.findFirstOrThrow({ where: { pipelineId: created.pipelineId } });
    expect(row.definition).toEqual(created.current?.definition);
    expect(row.policy).toEqual({ allowedDomains: [], allowedRecipients: [], provenance: [] });
  });

  it("does not show or change another user's pipeline", async () => {
    const other = await db.client.user.create({ data: { email: `other-${randomUUID()}@aime.test` } });
    const theirs = await db.client.pipeline.create({ data: { userId: other.userId, name: "Theirs" } });
    await agent.get(`/api/pipelines/${theirs.pipelineId}`).expect(404);
    await agent.post(`/api/pipelines/${theirs.pipelineId}/versions`).send({ source: V1 }).expect(404);
    await agent.post("/api/pipelines/compile").send({ source: V1, pipelineId: theirs.pipelineId }).expect(200);
    const list = (await agent.get("/api/pipelines").expect(200)).body as { name: string }[];
    expect(list.map((p) => p.name)).not.toContain("Theirs");
    await db.client.user.delete({ where: { userId: other.userId } });
  });
});

import { createPrismaConnection, type PrismaConnection } from "@ai-me/db";
import {
  type CompilePipelineResponse,
  type DryRunPipelineResponse,
  type PipelineDetailView,
  type PipelineSummaryView,
  type PipelineVersionView,
  type RunSummaryView,
  type StepTypeView,
} from "@ai-me/shared";
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
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.$executeRaw`DELETE FROM pgboss.job`;
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

  it("lists the step catalog for the review screen", async () => {
    const steps = (await agent.get("/api/steps").expect(200)).body as StepTypeView[];
    expect(steps).toContainEqual(
      expect.objectContaining({
        type: "gate.act",
        description: expect.any(String) as string,
        sideEffect: false,
        headed: false,
        category: "gate",
      }),
    );
    expect(steps.map((s) => s.type)).toContain("notify.telegram");
    // M36-T1: inputs and outputs as JSON Schema, for the step builder's forms and data picker
    const save = steps.find((s) => s.type === "data.save")!;
    expect(save.input.required).toEqual(["items"]);
    expect(save.input.properties?.complete).toMatchObject({ type: "boolean", default: false });
    expect(save.output.properties?.added).toMatchObject({ type: "array" });
    const send = steps.find((s) => s.type === "email.send")!;
    expect(send).toMatchObject({ category: "email", sideEffect: true });
    expect(steps.find((s) => s.type === "http.fetch")!.credentials).toEqual(expect.arrayContaining(["headers"]));
    expect(steps.find((s) => s.type === "llm.generate")!.llmOutput).toBe(true);
  });

  // M3-T4, M3-E1 (api part): dry run before saving (README §2.1)
  describe("drafts", () => {
    afterEach(async () => {
      await db.client.run.deleteMany();
      await db.client.pipeline.deleteMany();
      await db.client.userSetting.deleteMany();
    });

    const dryRun = async (source: string, pipelineId?: string) =>
      (await agent.post("/api/pipelines/dry-run").send({ source, pipelineId }).expect(202)).body as DryRunPipelineResponse;
    const runsOf = async (pipelineId: string) =>
      ((await agent.get(`/api/runs?pipelineId=${pipelineId}`).expect(200)).body as RunSummaryView[]).map((r) => [r.version, r.dryRun]);

    it("a pipeline started by an event gets an example of the event in a dry run; a scheduled one gets none", async () => {
      const source = `
name: Follow-up after applying
trigger: { on: application.status, status: [SUBMITTED] }
steps:
  - id: later
    type: flow.later
    with:
      pipeline: Follow-up reminder
      after: 7d
      cancelOn: { event: application.status, match: { applicationId: "{{trigger.applicationId}}" } }
`;
      const { run } = await dryRun(source);
      const detail = (await agent.get(`/api/runs/${run.runId}`).expect(200)).body as { triggerData: Record<string, unknown> };
      expect(detail.triggerData).toMatchObject({
        applicationId: "example-application",
        status: "SUBMITTED",
        job: { url: "https://jobs.example.com/example-role" },
      });
      const scheduled = await dryRun(V1);
      expect(((await agent.get(`/api/runs/${scheduled.run.runId}`).expect(200)).body as { triggerData: unknown }).triggerData).toBeNull();
    });

    it("a new pipeline: dry run its draft, save it as v1 (keeping the dry run), then enable it", async () => {
      const { pipeline, run } = await dryRun(V1);
      expect(pipeline).toMatchObject({ name: "Morning digest", currentVersion: null, hasDraft: true, current: null, versions: [] });
      expect(pipeline.draft).toMatchObject({ version: 1, changeSummary: null });
      expect(run).toMatchObject({ pipelineId: pipeline.pipelineId, version: 1, dryRun: true, trigger: "dry-run", status: "QUEUED" });

      await agent.patch(`/api/pipelines/${pipeline.pipelineId}`).send({ enabled: true }).expect(409);
      await agent.post(`/api/pipelines/${pipeline.pipelineId}/runs`).send({}).expect(404);
      await agent.get(`/api/pipelines/${pipeline.pipelineId}/versions/1`).expect(404);

      const saved = (await agent.post(`/api/pipelines/${pipeline.pipelineId}/versions`).send({ source: V1 }).expect(201))
        .body as PipelineDetailView;
      expect(saved).toMatchObject({ currentVersion: 1, hasDraft: false, draft: null, versions: [{ version: 1 }] });
      expect(saved.current?.pipelineVersionId).toBe(pipeline.draft?.pipelineVersionId);
      expect(await runsOf(pipeline.pipelineId)).toEqual([[1, true]]);

      await agent.patch(`/api/pipelines/${pipeline.pipelineId}`).send({ enabled: true }).expect(200);
    });

    it("an edit: a new dry run replaces the draft and its runs; saving another source drops the draft", async () => {
      const created = (await agent.post("/api/pipelines").send({ source: V1 }).expect(201)).body as PipelineDetailView;
      const first = await dryRun(V2, created.pipelineId);
      expect(first.pipeline).toMatchObject({ currentVersion: 1, hasDraft: true, draft: { version: 2 } });
      expect(first.pipeline.draft?.changeSummary).toMatch(/^step summary: with\.instruction/);

      const V3 = V1.replace("Summarize my day", "Summarize my week");
      const second = await dryRun(V3, created.pipelineId);
      expect(second.pipeline.draft?.version).toBe(2);
      expect(await db.client.run.count({ where: { runId: first.run.runId } })).toBe(0);

      // Saving V2 (not the V3 draft): the draft and its dry run go; V2 is saved as v2.
      const saved = (await agent.post(`/api/pipelines/${created.pipelineId}/versions`).send({ source: V2 }).expect(201))
        .body as PipelineDetailView;
      expect(saved).toMatchObject({ currentVersion: 2, draft: null });
      expect(saved.current?.definition.steps[0]?.with).toEqual({ instruction: "Summarize my day in 3 bullets" });
      expect(await runsOf(created.pipelineId)).toEqual([]);
      const list = (await agent.get("/api/pipelines").expect(200)).body as PipelineSummaryView[];
      expect(list).toEqual([expect.objectContaining({ currentVersion: 2, hasDraft: false })]);
    });

    it("discarding: a never-saved pipeline goes with its draft; a saved one keeps its versions", async () => {
      const fresh = await dryRun(V1);
      await agent.delete(`/api/pipelines/${fresh.pipeline.pipelineId}/draft`).expect(204);
      await agent.get(`/api/pipelines/${fresh.pipeline.pipelineId}`).expect(404);

      const created = (await agent.post("/api/pipelines").send({ source: V1 }).expect(201)).body as PipelineDetailView;
      await dryRun(V2, created.pipelineId);
      await agent.delete(`/api/pipelines/${created.pipelineId}/draft`).expect(204);
      const kept = (await agent.get(`/api/pipelines/${created.pipelineId}`).expect(200)).body as PipelineDetailView;
      expect(kept).toMatchObject({ currentVersion: 1, draft: null, versions: [{ version: 1 }] });
      expect(await db.client.run.count()).toBe(0);
    });

    it("refuses a dry run while the kill switch is on, or of a source that doesn't compile", async () => {
      await agent.put("/api/kill-switch").send({ engaged: true }).expect(200);
      await agent.post("/api/pipelines/dry-run").send({ source: V1 }).expect(409);
      await agent.put("/api/kill-switch").send({ engaged: false }).expect(200);
      await agent.post("/api/pipelines/dry-run").send({ source: "name: x\nsteps: []" }).expect(400);
      expect(await db.client.pipeline.count()).toBe(0);
    });

    // M37-T3: try up to a step: a dry run that names one of its steps
    it("a dry run tried up to a step keeps the step; a step it doesn't have is refused", async () => {
      await agent.post("/api/pipelines/dry-run").send({ source: V1, stopAfter: "nowhere" }).expect(400);
      expect(await db.client.pipeline.count()).toBe(0);
      const first = (await agent.post("/api/pipelines/dry-run").send({ source: V1, stopAfter: "summary" }).expect(202))
        .body as DryRunPipelineResponse;
      expect(first.run).toMatchObject({ dryRun: true, stopAfter: "summary" });
      const whole = await dryRun(V1, first.pipeline.pipelineId);
      expect(whole.run.stopAfter).toBeNull();
    });
  });

  it("does not show or change another user's pipeline", async () => {
    const other = await db.client.user.create({ data: { email: `other-${randomUUID()}@aime.test` } });
    const theirs = await db.client.pipeline.create({ data: { userId: other.userId, name: "Theirs" } });
    await agent.get(`/api/pipelines/${theirs.pipelineId}`).expect(404);
    await agent.post(`/api/pipelines/${theirs.pipelineId}/versions`).send({ source: V1 }).expect(404);
    await agent.post("/api/pipelines/dry-run").send({ source: V1, pipelineId: theirs.pipelineId }).expect(404);
    await agent.delete(`/api/pipelines/${theirs.pipelineId}/draft`).expect(404);
    await agent.post("/api/pipelines/compile").send({ source: V1, pipelineId: theirs.pipelineId }).expect(200);
    const list = (await agent.get("/api/pipelines").expect(200)).body as { name: string }[];
    expect(list.map((p) => p.name)).not.toContain("Theirs");
    await db.client.user.delete({ where: { userId: other.userId } });
  });
});

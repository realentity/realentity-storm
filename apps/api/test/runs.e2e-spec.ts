import { payloadHash } from "@realentity/storm-crypto";
import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { QUEUES } from "@realentity/storm-queue";
import {
  type KillSwitchView,
  type CostsView,
  type PipelineDetailView,
  type ProposalView,
  type RunDetailView,
  type RunSummaryView,
  type SettingsView,
  type SpendingView,
} from "@realentity/storm-shared";
import { defaultCatalog, type StepDefinition } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import request from "supertest";
import { z } from "zod";
import { freeName } from "./support/names";
import { createTestApp, type TestApp } from "./support/test-app";

/** Stand-ins for later milestones' steps. */
const TEST_STEPS: StepDefinition[] = [
  {
    type: "test.search",
    description: "returns jobs",
    sideEffect: false,
    saasSafe: true,
    input: z.object({ query: z.string() }),
    output: z.object({ items: z.array(z.object({ title: z.string(), recruiter: z.string() })) }),
  },
  {
    type: "test.send",
    description: "sends a message",
    sideEffect: true,
    saasSafe: true,
    targets: { to: "recipient" },
    input: z.object({ to: z.string(), body: z.string() }),
    output: z.object({ messageId: z.string() }),
  },
];

const REPLY = `
name: Replies
steps:
  - id: search
    type: test.search
    with: { query: dotnet }
  - id: shortlist
    type: gate.review
    with: { items: "{{search.items}}" }
  - id: reply
    type: test.send
    forEach: "{{shortlist.selected}}"
    with: { to: "{{item.recruiter}}", body: "Thanks for {{item.title}}" }
`;

const JOBS = [
  { title: "Senior .NET", recruiter: "ana@acme.test" },
  { title: "Lead .NET", recruiter: "bob@other.test" },
];

interface QueuedJob {
  name: string;
  data: Record<string, unknown>;
}

describe("runs, proposals and controls", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;
  let userId: string;

  beforeAll(async () => {
    api = await createTestApp({ catalog: defaultCatalog().with(...TEST_STEPS) });
    agent = await api.signedIn();
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.userSetting.deleteMany();
    await db.client.modelSetting.deleteMany();
    await db.client.$executeRaw`DELETE FROM pgboss.job`;
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  const queued = (): Promise<QueuedJob[]> =>
    db.client.$queryRaw<QueuedJob[]>`SELECT name, data FROM pgboss.job WHERE state = 'created' ORDER BY created_on`;

  async function createPipeline(source = REPLY): Promise<PipelineDetailView> {
    return (await agent.post("/api/pipelines").send({ source: await freeName(db, source) }).expect(201)).body as PipelineDetailView;
  }

  /** What the worker leaves behind at a gate: a waiting run, the gate step, and its proposal. */
  async function waitingAt(kind: "act" | "review"): Promise<{ runId: string; proposalId: string }> {
    const pipeline = await createPipeline();
    const run = await db.client.run.create({
      data: { userId, pipelineVersionId: pipeline.current!.pipelineVersionId, trigger: "manual", status: "WAITING_FOR_USER" },
    });
    const gate = await db.client.step.create({
      data: {
        runId: run.runId,
        stepKey: kind === "act" ? "replyGate" : "shortlist",
        itemIndex: kind === "act" ? 0 : null,
        type: kind === "act" ? "gate.act" : "gate.review",
        status: "WAITING",
        startedAt: new Date(),
      },
    });
    const proposal = await db.client.proposal.create({
      data: {
        userId,
        runId: run.runId,
        stepId: gate.stepId,
        stepKey: kind === "act" ? "reply" : "shortlist",
        itemIndex: kind === "act" ? 0 : null,
        status: "PENDING_REVIEW",
        target: kind === "act" ? "ana@acme.test" : "2 item(s) to review",
        targets:
          kind === "act" ? [{ field: "to", kind: "recipient", value: "ana@acme.test", basis: "provenance", isNew: true }] : undefined,
        originalPayload: kind === "act" ? { to: "ana@acme.test", body: "Thanks for Senior .NET" } : { items: JOBS },
      },
    });
    return { runId: run.runId, proposalId: proposal.proposalId };
  }

  describe("proposals", () => {
    // M2-T10
    it("lists what waits for the user, with its pipeline and targets", async () => {
      const { proposalId, runId } = await waitingAt("act");
      const list = (await agent.get("/api/proposals").expect(200)).body as ProposalView[];
      expect(list).toEqual([
        expect.objectContaining({
          proposalId,
          runId,
          pipelineName: "Replies",
          kind: "act",
          stepKey: "reply",
          itemIndex: 0,
          status: "PENDING_REVIEW",
          targets: [{ field: "to", kind: "recipient", value: "ana@acme.test", basis: "provenance", isNew: true }],
          decision: null,
        }),
      ]);
      expect((await agent.get("/api/proposals?status=DONE").expect(200)).body).toEqual([]);
      await agent.get("/api/proposals?status=whatever").expect(400);
    });

    // M2-T10, M2-T11
    it("approve: stores the payload and its hash, records the decision, and queues the run", async () => {
      const { proposalId, runId } = await waitingAt("act");
      const view = (await agent.post(`/api/proposals/${proposalId}/approve`).send({}).expect(200)).body as ProposalView;

      expect(view).toMatchObject({ status: "APPROVED", finalPayload: { to: "ana@acme.test", body: "Thanks for Senior .NET" } });
      expect(view.decision).toMatchObject({ kind: "APPROVED", reason: null });
      const row = await db.client.proposal.findUniqueOrThrow({ where: { proposalId } });
      expect(row.payloadHash).toBe(payloadHash({ to: "ana@acme.test", body: "Thanks for Senior .NET" }));
      // M6-T3: what the user approves to be sent is learned from (the worker makes it an example).
      const jobs = await queued();
      expect(jobs).toHaveLength(2);
      expect(jobs).toEqual(
        expect.arrayContaining([
          { name: QUEUES.runs, data: { runId } },
          { name: QUEUES.learning, data: { proposalId } },
        ]),
      );
    });

    it("approve with an edit: the edited payload is what gets hashed; the decision lists the changed fields", async () => {
      const { proposalId } = await waitingAt("act");
      const payload = { to: "ana@acme.test", body: "Thank you, Ana!" };
      const view = (await agent.post(`/api/proposals/${proposalId}/approve`).send({ payload }).expect(200)).body as ProposalView;

      expect(view.finalPayload).toEqual(payload);
      const decision = await db.client.decision.findUniqueOrThrow({ where: { proposalId } });
      expect(decision).toMatchObject({ kind: "EDITED", diff: { changed: ["body"] } });
      expect((await db.client.proposal.findUniqueOrThrow({ where: { proposalId } })).payloadHash).toBe(payloadHash(payload));
    });

    it("approve with an edit: the new targets the user lists are kept (lowercase) for the policy check", async () => {
      const { proposalId } = await waitingAt("act");
      await agent
        .post(`/api/proposals/${proposalId}/approve`)
        .send({ payload: { to: "Boss@Other.test", body: "Hi" }, approveNewTargets: ["Boss@Other.test"] })
        .expect(200);
      expect((await db.client.proposal.findUniqueOrThrow({ where: { proposalId } })).approvedNewTargets).toEqual(["boss@other.test"]);
    });

    it("refuses an edited payload that isn't valid input of the step it approves", async () => {
      const { proposalId } = await waitingAt("act");
      const response = await agent
        .post(`/api/proposals/${proposalId}/approve`)
        .send({ payload: { to: "ana@acme.test", body: 42 } })
        .expect(400);
      expect(response.body).toMatchObject({ message: "The edited payload is not valid", errors: [{ path: "payload.body" }] });
      expect((await db.client.proposal.findUniqueOrThrow({ where: { proposalId } })).status).toBe("PENDING_REVIEW");
      expect(await queued()).toEqual([]);
    });

    it("gate.review: approves a selection; refuses a payload that isn't one", async () => {
      const { proposalId } = await waitingAt("review");
      await agent
        .post(`/api/proposals/${proposalId}/approve`)
        .send({ payload: { items: "all" } })
        .expect(400);
      const view = (
        await agent
          .post(`/api/proposals/${proposalId}/approve`)
          .send({ payload: { items: [JOBS[1]] } })
          .expect(200)
      ).body as ProposalView;
      expect(view).toMatchObject({ kind: "review", status: "APPROVED", finalPayload: { items: [JOBS[1]] } });
      expect(view.decision?.kind).toBe("EDITED");
    });

    it("reject: records the user's reason and queues the run (its later steps for that item are skipped)", async () => {
      const { proposalId, runId } = await waitingAt("act");
      const view = (await agent.post(`/api/proposals/${proposalId}/reject`).send({ reason: "Not this one" }).expect(200))
        .body as ProposalView;
      expect(view).toMatchObject({ status: "REJECTED", finalPayload: null, decision: { kind: "REJECTED", reason: "Not this one" } });
      expect(await queued()).toEqual([{ name: QUEUES.runs, data: { runId } }]);
    });

    it("a proposal is decided once", async () => {
      const { proposalId } = await waitingAt("act");
      await agent.post(`/api/proposals/${proposalId}/approve`).send({}).expect(200);
      await agent.post(`/api/proposals/${proposalId}/approve`).send({}).expect(409);
      await agent.post(`/api/proposals/${proposalId}/reject`).send({}).expect(409);
      expect((await queued()).map((job) => job.name).sort()).toEqual([QUEUES.learning, QUEUES.runs]);
    });

    /** A rejection as the worker leaves it: the gate done, the item's later steps skipped. */
    async function rejected(): Promise<{ runId: string; proposalId: string }> {
      const waiting = await waitingAt("act");
      await agent.post(`/api/proposals/${waiting.proposalId}/reject`).send({ reason: "Wrong one" }).expect(200);
      await db.client.step.updateMany({
        where: { runId: waiting.runId, stepKey: "replyGate" },
        data: { status: "DONE", output: { approved: false }, finishedAt: new Date() },
      });
      await db.client.step.create({
        data: { runId: waiting.runId, stepKey: "reply", itemIndex: 0, type: "test.send", status: "SKIPPED", error: "Rejected at the gate", finishedAt: new Date() },
      });
      await db.client.$executeRaw`DELETE FROM pgboss.job`;
      return waiting;
    }

    it("undo reject: the proposal waits again, its decision and the rejection's skips gone", async () => {
      const { proposalId, runId } = await rejected();
      const view = (await agent.post(`/api/proposals/${proposalId}/undo-reject`).expect(200)).body as ProposalView;
      expect(view).toMatchObject({ status: "PENDING_REVIEW", finalPayload: null, decision: null });
      expect(await db.client.decision.count({ where: { proposalId } })).toBe(0);
      const steps = await db.client.step.findMany({ where: { runId } });
      expect(steps.map((s) => [s.stepKey, s.status, s.output])).toEqual([["replyGate", "WAITING", null]]);
      expect(await queued()).toEqual([]);

      await agent.post(`/api/proposals/${proposalId}/approve`).send({}).expect(200);
      expect((await queued()).map((job) => job.name).sort()).toEqual([QUEUES.learning, QUEUES.runs]);
    });

    it("undo reject: not once the run went on, or no longer waits for the user", async () => {
      const went = await rejected();
      await db.client.step.create({
        data: { runId: went.runId, stepKey: "after", type: "test.search", status: "DONE", startedAt: new Date(), finishedAt: new Date() },
      });
      await agent.post(`/api/proposals/${went.proposalId}/undo-reject`).expect(409);

      const done = await rejected();
      await db.client.run.update({ where: { runId: done.runId }, data: { status: "DONE", finishedAt: new Date() } });
      await agent.post(`/api/proposals/${done.proposalId}/undo-reject`).expect(409);
      expect(await db.client.proposal.findUniqueOrThrow({ where: { proposalId: done.proposalId } })).toMatchObject({ status: "REJECTED" });

      const { proposalId } = await waitingAt("act");
      await agent.post(`/api/proposals/${proposalId}/undo-reject`).expect(409);
    });

    it("previews of a dry run can't be approved", async () => {
      const { proposalId } = await waitingAt("act");
      await db.client.proposal.update({ where: { proposalId }, data: { status: "PREVIEW" } });
      await agent.post(`/api/proposals/${proposalId}/approve`).send({}).expect(409);
    });

    it("404 for a proposal that doesn't exist; 401 without a session", async () => {
      await agent.get("/api/proposals/00000000-0000-4000-8000-000000000000").expect(404);
      await agent.post("/api/proposals/00000000-0000-4000-8000-000000000000/approve").send({}).expect(404);
      const { proposalId } = await waitingAt("act");
      await request(api.http).post(`/api/proposals/${proposalId}/approve`).send({}).expect(401);
    });
  });

  describe("runs", () => {
    // M2-T15 (manual trigger), M2-T18
    it("starts a run of the current version and queues it; a dry run is marked as one", async () => {
      const pipeline = await createPipeline();
      const run = (await agent.post(`/api/pipelines/${pipeline.pipelineId}/runs`).send({}).expect(202)).body as RunDetailView;
      expect(run).toMatchObject({ pipelineId: pipeline.pipelineId, version: 1, trigger: "manual", dryRun: false, status: "QUEUED" });

      const dry = (await agent.post(`/api/pipelines/${pipeline.pipelineId}/runs`).send({ dryRun: true }).expect(202)).body as RunDetailView;
      expect(dry).toMatchObject({ trigger: "dry-run", dryRun: true, status: "QUEUED" });

      expect(await queued()).toEqual([
        { name: QUEUES.runs, data: { runId: run.runId } },
        { name: QUEUES.runs, data: { runId: dry.runId } },
      ]);
    });

    it("lists runs (newest first, filtered by pipeline) and shows one with its steps and proposals", async () => {
      const { runId } = await waitingAt("act");
      const other = await createPipeline(REPLY.replace("name: Replies", "name: Other"));
      await agent.post(`/api/pipelines/${other.pipelineId}/runs`).send({}).expect(202);

      const all = (await agent.get("/api/runs").expect(200)).body as RunSummaryView[];
      expect(all.map((r) => r.pipelineName)).toEqual(["Other", "Replies"]);
      const filtered = (await agent.get(`/api/runs?pipelineId=${other.pipelineId}`).expect(200)).body as RunSummaryView[];
      expect(filtered).toHaveLength(1);

      const detail = (await agent.get(`/api/runs/${runId}`).expect(200)).body as RunDetailView;
      expect(detail.steps.map((s) => [s.stepKey, s.status])).toEqual([["replyGate", "WAITING"]]);
      expect(detail.proposals.map((p) => p.status)).toEqual(["PENDING_REVIEW"]);
      await agent.get("/api/runs/00000000-0000-4000-8000-000000000000").expect(404);
    });

    // M3-T7
    it("filters history by pipeline and version, status, date and target, and pages with `before`", async () => {
      const { runId: waiting } = await waitingAt("act");
      const replies = await db.client.pipeline.findFirstOrThrow({ where: { name: "Replies" } });
      await agent
        .post(`/api/pipelines/${replies.pipelineId}/versions`)
        .send({ source: REPLY.replace("dotnet", "golang") })
        .expect(201);
      const v2 = (await agent.post(`/api/pipelines/${replies.pipelineId}/runs`).send({}).expect(202)).body as RunDetailView;
      const old = await db.client.run.create({
        data: {
          userId,
          pipelineVersionId: (await db.client.pipelineVersion.findFirstOrThrow({ where: { pipelineId: replies.pipelineId, version: 1 } }))
            .pipelineVersionId,
          trigger: "schedule",
          status: "DONE",
          startedAt: new Date("2026-10-01T08:00:00Z"),
        },
      });
      const ids = async (query: string) =>
        ((await agent.get(`/api/runs?${query}`).expect(200)).body as RunSummaryView[]).map((r) => r.runId);

      expect(await ids(`pipelineId=${replies.pipelineId}&version=1`)).toEqual([waiting, old.runId]);
      expect(await ids(`pipelineId=${replies.pipelineId}&version=2`)).toEqual([v2.runId]);
      expect(await ids("status=WAITING_FOR_USER")).toEqual([waiting]);
      expect(await ids("from=2026-10-01&to=2026-10-01")).toEqual([old.runId]);
      expect(await ids("target=ANA@acme")).toEqual([waiting]);
      const [first, ...rest] = await ids("limit=1");
      expect(rest).toEqual([]);
      const startedAt = ((await agent.get(`/api/runs/${first}`).expect(200)).body as RunDetailView).startedAt;
      expect(await ids(`before=${encodeURIComponent(startedAt)}`)).not.toContain(first);

      await agent.get("/api/runs?version=1").expect(400);
      await agent.get("/api/runs?status=LOST").expect(400);
      await agent.get("/api/runs?from=yesterday").expect(400);
      await agent.get("/api/runs?sort=name").expect(400);
    });

    // M3-T6
    it("shows each step's LLM usage and the run's total cost", async () => {
      const { runId } = await waitingAt("review");
      const usage = {
        models: ["claude-haiku-5-5"],
        calls: 2,
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.0002,
      };
      await db.client.step.create({
        data: { runId, stepKey: "search", type: "llm.classify", status: "DONE", startedAt: new Date(0), llmUsage: usage },
      });
      await db.client.step.create({
        data: {
          runId,
          stepKey: "summary",
          type: "llm.summarize",
          status: "FAILED",
          startedAt: new Date(1),
          llmUsage: { ...usage, costUsd: 0.0031 },
        },
      });

      const detail = (await agent.get(`/api/runs/${runId}`).expect(200)).body as RunDetailView;
      expect(detail.costUsd).toBe(0.0033);
      expect(detail.steps.map((s) => [s.stepKey, s.llmUsage?.costUsd ?? null])).toEqual([
        ["search", 0.0002],
        ["summary", 0.0031],
        ["shortlist", null],
      ]);
      expect(detail.steps[0]?.llmUsage).toEqual({
        models: ["claude-haiku-5-5"],
        calls: 2,
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.0002,
      });
    });
  });

  describe("pipelines", () => {
    it("enabling or disabling asks the worker to sync schedules; essential is a flag", async () => {
      const pipeline = await createPipeline();
      expect(pipeline).toMatchObject({ enabled: false, essential: false });
      await db.client.$executeRaw`DELETE FROM pgboss.job`;

      const enabled = (await agent.patch(`/api/pipelines/${pipeline.pipelineId}`).send({ enabled: true }).expect(200))
        .body as PipelineDetailView;
      expect(enabled.enabled).toBe(true);
      expect((await queued()).map((j) => j.name)).toEqual([QUEUES.syncSchedules]);

      const essential = (await agent.patch(`/api/pipelines/${pipeline.pipelineId}`).send({ essential: true }).expect(200))
        .body as PipelineDetailView;
      expect(essential).toMatchObject({ enabled: true, essential: true });
      await agent.patch(`/api/pipelines/${pipeline.pipelineId}`).send({}).expect(400);
      await agent.patch(`/api/pipelines/${pipeline.pipelineId}`).send({ name: "x" }).expect(400);
    });
  });

  describe("kill switch", () => {
    // M2-S5 (api side; the runner stops running runs at the next step boundary)
    it("engaging stops queued and waiting runs, expires their proposals, and refuses new work", async () => {
      const { runId: waiting, proposalId } = await waitingAt("act");
      const pipeline = await createPipeline(REPLY.replace("name: Replies", "name: Queued"));
      const queuedRun = (await agent.post(`/api/pipelines/${pipeline.pipelineId}/runs`).send({}).expect(202)).body as RunDetailView;
      const running = await db.client.run.create({
        data: { userId, pipelineVersionId: pipeline.current!.pipelineVersionId, trigger: "manual", status: "RUNNING" },
      });

      const view = (await agent.put("/api/kill-switch").send({ engaged: true }).expect(200)).body as KillSwitchView;
      expect(view).toMatchObject({ engaged: true, stoppedRuns: 2 });

      const statuses = Object.fromEntries((await db.client.run.findMany()).map((r) => [r.runId, [r.status, r.summary]]));
      expect(statuses).toEqual({
        [waiting]: ["ABORTED", "Stopped by the kill switch"],
        [queuedRun.runId]: ["ABORTED", "Stopped by the kill switch"],
        [running.runId]: ["RUNNING", null],
      });
      expect((await db.client.proposal.findUniqueOrThrow({ where: { proposalId } })).status).toBe("EXPIRED");

      await agent.post(`/api/proposals/${proposalId}/approve`).send({}).expect(409);
      await agent.post(`/api/pipelines/${pipeline.pipelineId}/runs`).send({}).expect(409);
      expect(((await agent.get("/api/kill-switch").expect(200)).body as KillSwitchView).engaged).toBe(true);
    });

    it("an approval waiting in the queue can't act after the kill switch", async () => {
      const { proposalId, runId } = await waitingAt("act");
      await agent.post(`/api/proposals/${proposalId}/approve`).send({}).expect(200);
      await agent.put("/api/kill-switch").send({ engaged: true }).expect(200);

      // The job is still queued, but the run can't be claimed and the approval expired.
      expect((await queued()).filter((job) => job.name === QUEUES.runs)).toEqual([{ name: QUEUES.runs, data: { runId } }]);
      expect((await db.client.run.findUniqueOrThrow({ where: { runId } })).status).toBe("ABORTED");
      expect((await db.client.proposal.findUniqueOrThrow({ where: { proposalId } })).status).toBe("EXPIRED");
    });

    it("releasing lets new work start again", async () => {
      const pipeline = await createPipeline();
      await agent.put("/api/kill-switch").send({ engaged: true }).expect(200);
      expect((await agent.put("/api/kill-switch").send({ engaged: false }).expect(200)).body).toEqual({ engaged: false, engagedAt: null });
      await agent.post(`/api/pipelines/${pipeline.pipelineId}/runs`).send({}).expect(202);
    });
  });

  describe("settings", () => {
    it("global rate limits for side-effect steps, and the monthly budget", async () => {
      expect((await agent.get("/api/settings").expect(200)).body).toMatchObject({
        rateLimits: {},
        monthlyBudgetUsd: null,
        budgetSource: null,
      });

      const saved = (
        await agent
          .put("/api/settings")
          .send({ rateLimits: { "test.send": "20/day" }, monthlyBudgetUsd: 25.5 })
          .expect(200)
      ).body as SettingsView;
      expect(saved).toMatchObject({ rateLimits: { "test.send": "20/day" }, monthlyBudgetUsd: 25.5, budgetSource: "settings" });

      const cleared = (await agent.put("/api/settings").send({ monthlyBudgetUsd: null }).expect(200)).body as SettingsView;
      expect(cleared).toMatchObject({ rateLimits: { "test.send": "20/day" }, monthlyBudgetUsd: null, budgetSource: null });
    });

    // M3-T9
    it("a model per LLM task: the user's choice, or the default and where it comes from", async () => {
      const initial = (await agent.get("/api/settings").expect(200)).body as SettingsView;
      expect(initial.models).toEqual({
        "email.classify": { model: "claude-haiku-5-5", effort: "low", source: "default" },
        "email.draftReply": { model: "claude-sonnet-5-5", effort: "medium", source: "default" },
        "email.draftFollowUp": { model: "claude-sonnet-5-5", effort: "medium", source: "default" },
        "bill.read": { model: "claude-sonnet-5-5", effort: "medium", source: "default" },
        "llm.classify": { model: "claude-haiku-5-5", effort: "low", source: "default" },
        "llm.score": { model: "claude-haiku-5-5", effort: "low", source: "default" },
        "llm.generate": { model: "claude-sonnet-5-5", effort: "medium", source: "default" },
        "llm.summarize": { model: "claude-sonnet-5-5", effort: "medium", source: "default" },
        "llm.extract": { model: "claude-sonnet-5-5", effort: "medium", source: "default" },
        "application.outcome": { model: "claude-haiku-5-5", effort: "low", source: "default" },
        reflection: { model: "claude-opus-5-5", effort: "high", source: "default" },
        builder: { model: "claude-opus-5-5", effort: "high", source: "default" },
        "browser.teach": { model: "claude-sonnet-5-5", effort: "medium", source: "default" },
        "shop.product": { model: "claude-haiku-5-5", effort: "low", source: "default" },
        "browser.mapForm": { model: "claude-sonnet-5-5", effort: "medium", source: "default" },
        "browser.agent": { model: "claude-sonnet-5-5", effort: "medium", source: "default" },
        "browser.agent.escalation": { model: "claude-opus-5-5", effort: "high", source: "default" },
      });

      const chosen = (
        await agent
          .put("/api/settings")
          .send({ models: { "llm.generate": { model: "claude-opus-5-5", effort: "high" } } })
          .expect(200)
      ).body as SettingsView;
      expect(chosen.models["llm.generate"]).toEqual({ model: "claude-opus-5-5", effort: "high", source: "settings" });
      expect(await db.client.modelSetting.findMany({ select: { taskKey: true, model: true, effort: true } })).toEqual([
        { taskKey: "llm.generate", model: "claude-opus-5-5", effort: "high" },
      ]);

      const reset = (
        await agent
          .put("/api/settings")
          .send({ models: { "llm.generate": null } })
          .expect(200)
      ).body as SettingsView;
      expect(reset.models["llm.generate"].source).toBe("default");
      expect(await db.client.modelSetting.count()).toBe(0);

      await agent
        .put("/api/settings")
        .send({ models: { "llm.generate": { model: "gpt-9", effort: "high" } } })
        .expect(400);
      await agent
        .put("/api/settings")
        .send({ models: { "email.send": { model: "claude-opus-5-5", effort: "high" } } })
        .expect(400);
      await agent
        .put("/api/settings")
        .send({ models: { "llm.score": { model: "claude-opus-5-5", effort: "huge" } } })
        .expect(400);
    });

    it("refuses limits on unknown or non-side-effect steps, and malformed limits", async () => {
      const response = await agent
        .put("/api/settings")
        .send({ rateLimits: { "llm.generate": "5/day", "mail.send": "5/day" } })
        .expect(400);
      expect(response.body).toMatchObject({
        errors: [
          { path: "rateLimits.llm.generate", message: "only side-effect steps have rate limits" },
          { path: "rateLimits.mail.send", message: 'unknown step type "mail.send"' },
        ],
      });
      await agent
        .put("/api/settings")
        .send({ rateLimits: { "test.send": "lots" } })
        .expect(400);
    });
  });
  // M17: retrying a failed run (T1, S1) and what a pipeline costs (T3, E1's api part).
  describe("M17: retry and cost", () => {
    const usage = (costUsd: number) => ({ models: ["claude-sonnet-5-5"], calls: 1, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd });

    /** A finished run of the pipeline as the worker leaves it: these steps, with their status and LLM cost. */
    async function finished(pipeline: PipelineDetailView, status: "DONE" | "FAILED", steps: [string, string, "DONE" | "FAILED" | "RUNNING", number][], dryRun = false) {
      const run = await db.client.run.create({
        data: { userId, pipelineVersionId: pipeline.current!.pipelineVersionId, trigger: dryRun ? "dry-run" : "manual", dryRun, status, finishedAt: new Date() },
      });
      for (const [stepKey, type, stepStatus, cost] of steps) {
        await db.client.step.create({ data: { runId: run.runId, stepKey, type, status: stepStatus, startedAt: new Date(), llmUsage: cost ? usage(cost) : undefined, error: stepStatus === "FAILED" ? "boom" : null } });
      }
      return run.runId;
    }

    it("a failed run goes on from its failed step: the step cleared, the run queued; never after a failed side effect", async () => {
      const pipeline = await createPipeline();
      const runId = await finished(pipeline, "FAILED", [
        ["search", "test.search", "DONE", 0.02],
        ["shortlist", "gate.review", "FAILED", 0],
      ]);
      const before = (await agent.get(`/api/runs/${runId}`).expect(200)).body as RunDetailView;
      expect(before).toMatchObject({ retry: { possible: true, reason: null }, costUsd: 0.02 });

      const retried = (await agent.post(`/api/runs/${runId}/retry`).expect(202)).body as RunDetailView;
      expect(retried).toMatchObject({ status: "QUEUED", finishedAt: null, retry: null });
      expect(retried.steps.map((s) => [s.stepKey, s.status])).toEqual([["search", "DONE"]]);
      expect((await queued()).map((j) => j.data)).toEqual([{ runId }]);
      await agent.post(`/api/runs/${runId}/retry`).expect(409);

      const sent = await finished(pipeline, "FAILED", [
        ["search", "test.search", "DONE", 0],
        ["reply", "test.send", "FAILED", 0],
      ]);
      const view = (await agent.get(`/api/runs/${sent}`).expect(200)).body as RunDetailView;
      expect(view.retry).toEqual({ possible: false, reason: "reply (test.send) failed and may have gone out: check, then start a new run" });
      const refused = await agent.post(`/api/runs/${sent}/retry`).expect(409);
      expect((refused.body as { message: string }).message).toContain("may have gone out");
      expect(await db.client.step.count({ where: { runId: sent } })).toBe(2);

      const done = await finished(pipeline, "DONE", [["search", "test.search", "DONE", 0]]);
      expect(((await agent.get(`/api/runs/${done}`).expect(200)).body as RunDetailView).retry).toBeNull();
    });

    // M19-T3, M19-T4 (the setting)
    it("Settings: this month against the budget, the last 30 days by step type and model; the weekly review on and off", async () => {
      const pipeline = await createPipeline();
      const runId = await finished(pipeline, "DONE", [
        ["search", "test.search", "DONE", 0],
        ["score", "llm.score", "DONE", 0.5],
        ["draft", "llm.generate", "DONE", 0.25],
      ]);
      await db.client.step.create({
        data: { runId, stepKey: "score", itemIndex: 1, type: "llm.score", status: "DONE", startedAt: new Date(), llmUsage: { ...usage(0.125), models: ["claude-haiku-5-5"], calls: 3 } },
      });
      await db.client.step.create({
        data: { runId, stepKey: "score", itemIndex: 2, type: "llm.score", status: "DONE", startedAt: new Date(Date.now() - 31 * 86_400_000), llmUsage: usage(9) },
      });
      await agent.put("/api/settings").send({ monthlyBudgetUsd: 10 }).expect(200);

      const spending = (await agent.get("/api/settings/spending").expect(200)).body as SpendingView;
      expect(spending).toMatchObject({ monthlyBudgetUsd: 10, totalUsd: 0.875 });
      expect(spending.monthSpentUsd).toBeGreaterThanOrEqual(0.875); // the 31-day-old step may fall in this month too
      expect(spending.rows).toEqual([
        { source: "llm.score", model: "claude-sonnet-5-5", calls: 1, costUsd: 0.5 },
        { source: "llm.generate", model: "claude-sonnet-5-5", calls: 1, costUsd: 0.25 },
        { source: "llm.score", model: "claude-haiku-5-5", calls: 3, costUsd: 0.125 },
      ]);

      expect(((await agent.get("/api/settings").expect(200)).body as SettingsView).weeklyReview).toBe(true);
      expect(((await agent.put("/api/settings").send({ weeklyReview: false }).expect(200)).body as SettingsView).weeklyReview).toBe(false);
      await agent.put("/api/settings").send({ weeklyReview: true, monthlyBudgetUsd: null }).expect(200);
    });

    // M28-I1
    it("Costs: every run of the window with its LLM steps (items, cache tokens); runs without LLM calls too; older runs left out", async () => {
      const pipeline = await createPipeline();
      const runId = await finished(pipeline, "DONE", [
        ["search", "test.search", "DONE", 0],
        ["score", "llm.score", "DONE", 0.5],
      ]);
      await db.client.step.create({
        data: { runId, stepKey: "draft", itemIndex: 1, type: "llm.generate", status: "DONE", startedAt: new Date(Date.now() + 1000), llmUsage: { ...usage(0.25), cacheReadTokens: 900, cacheWriteTokens: 50 } },
      });
      const dry = await finished(pipeline, "DONE", [["search", "test.search", "DONE", 0]], true);
      const old = await finished(pipeline, "DONE", [["score", "llm.score", "DONE", 9]]);
      await db.client.run.update({ where: { runId: old }, data: { startedAt: new Date(Date.now() - 10 * 86_400_000) } });

      const costs = (await agent.get("/api/costs?days=7").expect(200)).body as CostsView;
      expect(costs).toMatchObject({ days: 7, truncated: false });
      expect(costs.runs.map((r) => [r.runId, r.dryRun, r.costUsd]).sort()).toEqual([[dry, true, 0], [runId, false, 0.75]].sort());
      const paid = costs.runs.find((r) => r.runId === runId)!;
      expect(paid).toMatchObject({ pipelineName: "Replies", version: 1, status: "DONE" });
      expect(paid.steps).toEqual([
        { stepKey: "score", itemIndex: null, type: "llm.score", models: ["claude-sonnet-5-5"], calls: 1, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5 },
        { stepKey: "draft", itemIndex: 1, type: "llm.generate", models: ["claude-sonnet-5-5"], calls: 1, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50, costUsd: 0.25 },
      ]);

      expect(((await agent.get("/api/costs").expect(200)).body as CostsView).runs).toHaveLength(3);
      await agent.get("/api/costs?days=0").expect(400);
    });

    it("cost: per run in the runs list; per pipeline the last 30 days, per run, and per month on its schedule", async () => {
      const scheduled = await createPipeline(REPLY.replace("name: Replies", 'name: Daily\ntrigger: { schedule: "0 8 * * *", tz: Europe/Sofia }'));
      const none = (await agent.get(`/api/pipelines/${scheduled.pipelineId}`).expect(200)).body as PipelineDetailView;
      expect(none.cost).toEqual({ days: 30, runs: 0, dryRuns: 0, totalUsd: 0, perRunUsd: null, runsPerMonth: 30, perMonthUsd: null });

      // Only a dry run so far: it stands in for a run.
      await finished(scheduled, "DONE", [["search", "test.search", "DONE", 0.05]], true);
      expect(((await agent.get(`/api/pipelines/${scheduled.pipelineId}`).expect(200)).body as PipelineDetailView).cost).toMatchObject({
        runs: 1,
        dryRuns: 1,
        perRunUsd: 0.05,
        perMonthUsd: 1.5,
      });

      const a = await finished(scheduled, "DONE", [["search", "test.search", "DONE", 0.01], ["reply", "test.send", "DONE", 0.02]]);
      await finished(scheduled, "DONE", [["search", "test.search", "DONE", 0.01]]);
      const old = await finished(scheduled, "DONE", [["search", "test.search", "DONE", 9]]);
      await db.client.run.update({ where: { runId: old }, data: { startedAt: new Date(Date.now() - 40 * 86_400_000) } });

      const cost = ((await agent.get(`/api/pipelines/${scheduled.pipelineId}`).expect(200)).body as PipelineDetailView).cost;
      // Real runs now: (0.03 + 0.01) / 2 per run, 30 a month; the dry run counts in what was spent, the old run not.
      expect(cost).toEqual({ days: 30, runs: 3, dryRuns: 1, totalUsd: 0.09, perRunUsd: 0.02, runsPerMonth: 30, perMonthUsd: 0.6 });
      const list = (await agent.get(`/api/runs?pipelineId=${scheduled.pipelineId}`).expect(200)).body as RunSummaryView[];
      expect(list.find((r) => r.runId === a)?.costUsd).toBe(0.03);

      const manual = await createPipeline();
      expect(((await agent.get(`/api/pipelines/${manual.pipelineId}`).expect(200)).body as PipelineDetailView).cost).toMatchObject({ runsPerMonth: null, perMonthUsd: null });
    });
  });
});

import { payloadHash } from "@ai-me/crypto";
import { createPrismaConnection, type PrismaConnection } from "@ai-me/db";
import { QUEUES } from "@ai-me/queue";
import {
  type KillSwitchView,
  type PipelineDetailView,
  type ProposalView,
  type RunDetailView,
  type RunSummaryView,
  type SettingsView,
} from "@ai-me/shared";
import { defaultCatalog, type StepDefinition } from "@ai-me/steps";
import { TestEnvironment } from "@ai-me/testing";
import request from "supertest";
import { z } from "zod";
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
    await db.client.$executeRaw`DELETE FROM pgboss.job`;
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  const queued = (): Promise<QueuedJob[]> =>
    db.client.$queryRaw<QueuedJob[]>`SELECT name, data FROM pgboss.job WHERE state = 'created' ORDER BY created_on`;

  async function createPipeline(source = REPLY): Promise<PipelineDetailView> {
    return (await agent.post("/api/pipelines").send({ source }).expect(201)).body as PipelineDetailView;
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
    it("lists what waits for me, with its pipeline and targets", async () => {
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
      expect(await queued()).toEqual([{ name: QUEUES.runs, data: { runId } }]);
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

    it("approve with an edit: the new targets I list are kept (lowercase) for the policy check", async () => {
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

    it("reject: records my reason and queues the run (its later steps for that item are skipped)", async () => {
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
      expect(await queued()).toHaveLength(1);
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
      expect(await queued()).toEqual([{ name: QUEUES.runs, data: { runId } }]);
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
      expect((await agent.get("/api/settings").expect(200)).body).toEqual({ rateLimits: {}, monthlyBudgetUsd: null, budgetSource: null });

      const saved = (
        await agent
          .put("/api/settings")
          .send({ rateLimits: { "test.send": "20/day" }, monthlyBudgetUsd: 25.5 })
          .expect(200)
      ).body as SettingsView;
      expect(saved).toEqual({ rateLimits: { "test.send": "20/day" }, monthlyBudgetUsd: 25.5, budgetSource: "settings" });

      const cleared = (await agent.put("/api/settings").send({ monthlyBudgetUsd: null }).expect(200)).body as SettingsView;
      expect(cleared).toEqual({ rateLimits: { "test.send": "20/day" }, monthlyBudgetUsd: null, budgetSource: null });
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
});

import { payloadHash } from "@realentity/storm-crypto";
import { createPrismaConnection, type Prisma, type PrismaConnection, type RunStatus } from "@realentity/storm-db";
import { JobQueue, QUEUES } from "@realentity/storm-queue";
import { PipelineCompiler } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { z } from "zod";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/browser/artifact-store";
import { JobHandlers } from "../src/jobs/job-handlers";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { catalog, Counting, createVersion, JOBS } from "./support/test-steps";

const DIGEST = `
name: Digest
trigger: { schedule: "0 8 * * 1-5" }
steps:
  - id: search
    type: test.search
    with: { query: dotnet }
  - id: tell
    type: notify.telegram
    with: { text: "Jobs: {{search.items}}" }
`;

const REPLY = `
name: Replies
steps:
  - id: search
    type: test.search
    with: { query: dotnet }
  - id: reply
    type: test.send
    forEach: "{{search.items}}"
    with: { to: "{{item.recruiter}}", body: "Thanks for {{item.title}}" }
`;

const headedCatalog = catalog.with({
  type: "test.watch",
  description: "drives the headed browser",
  sideEffect: false,
  saasSafe: false,
  headed: true,
  input: z.object({ url: z.string() }),
  output: z.object({ seen: z.boolean() }),
});
const headedCompiler = new PipelineCompiler(headedCatalog);

interface QueuedJob {
  name: string;
  startAfter: Date;
}

describe("Queue jobs", () => {
  let db: PrismaConnection;
  let userId: string;
  let queue: JobQueue;
  let search: Counting, send: Counting, telegram: Counting;
  let runner: PipelineRunner;
  let handlers: JobHandlers;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    queue = await JobQueue.start({ connectionString: process.env.DATABASE_URL!, role: "worker" });
  });

  beforeEach(async () => {
    search = new Counting("test.search", () => ({ items: JOBS }));
    send = new Counting("test.send", () => ({ messageId: "m-1" }));
    telegram = new Counting("notify.telegram", () => ({ sent: true }));
    runner = new PipelineRunner(db.client, headedCatalog, new ExecutorRegistry([search, send, telegram]));
    handlers = new JobHandlers(db.client, runner, queue);
    for (const name of Object.values(QUEUES)) await queue.boss.deleteAllJobs(name);
  });

  afterEach(async () => {
    for (const name of Object.values(QUEUES)) await queue.boss.offWork(name);
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.userSetting.deleteMany();
  });

  afterAll(async () => {
    await queue.stop();
    await db.close();
  });

  const version = (source: string) => createVersion(db.client, userId, source, headedCompiler);

  const pipelineOf = async (pipelineVersionId: string) =>
    (await db.client.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId } })).pipelineId;

  const jobsFor = (runId: string): Promise<QueuedJob[]> =>
    db.client.$queryRaw<QueuedJob[]>`
      SELECT name, start_after AS "startAfter" FROM pgboss.job WHERE data->>'runId' = ${runId} AND state = 'created'`;

  async function until(runId: string, status: RunStatus, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = await db.client.run.findUniqueOrThrow({ where: { runId } });
      if (run.status === status) return;
      if (Date.now() > deadline) throw new Error(`Run is ${run.status}, expected ${status}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  it("a worker advances a run sent to the queue", async () => {
    await handlers.consume({ concurrency: 1, pollingIntervalSeconds: 0.5 });
    const runId = await runner.start(await version(DIGEST), { trigger: "manual" });
    await queue.enqueueRun({ runId, headed: false });

    await until(runId, "DONE");
    expect(telegram.calls).toHaveLength(1);
  });

  // M2-T10: approve → resume job → the approved side effect executes
  it("resumes a waiting run when a decision's job arrives", async () => {
    await handlers.consume({ concurrency: 1, pollingIntervalSeconds: 0.5 });
    const runId = await runner.start(await version(REPLY), { trigger: "manual" });
    await queue.enqueueRun({ runId, headed: false });
    await until(runId, "WAITING_FOR_USER");

    for (const p of await db.client.proposal.findMany({ where: { runId } })) {
      const payload = p.originalPayload as Prisma.InputJsonObject;
      await db.client.proposal.update({
        where: { proposalId: p.proposalId },
        data: { status: "APPROVED", finalPayload: payload, payloadHash: payloadHash(payload) },
      });
    }
    await queue.enqueueRun({ runId, headed: false });

    await until(runId, "DONE");
    expect(send.calls.map((c) => c.to)).toEqual(["ana@acme.test", "bob@other.test"]);
  });

  // M2-I5: the job for the rest of the run waits for the window
  it("sends a rate-limited run again for when the limit allows", async () => {
    const runId = await runner.start(await version(REPLY.replace("steps:", "limits: { test.send: 1/hour }\nsteps:")), {
      trigger: "manual",
    });
    await handlers.advance(runId);
    for (const p of await db.client.proposal.findMany({ where: { runId } })) {
      const payload = p.originalPayload as Prisma.InputJsonObject;
      await db.client.proposal.update({
        where: { proposalId: p.proposalId },
        data: { status: "APPROVED", finalPayload: payload, payloadHash: payloadHash(payload) },
      });
    }

    await expect(handlers.advance(runId)).resolves.toBe("QUEUED");
    const run = await db.client.run.findUniqueOrThrow({ where: { runId } });
    expect(await jobsFor(runId)).toEqual([{ name: QUEUES.runs, startAfter: run.resumeAt }]);
    expect(send.calls).toHaveLength(1);
  });

  it("routes runs that need the headed browser to the serialized queue", async () => {
    const runId = await runner.start(
      await version(`
name: Watch
steps:
  - id: watch
    type: test.watch
    with: { url: "https://example.org" }
`),
      { trigger: "manual" },
    );
    const run = await db.client.run.findUniqueOrThrow({ where: { runId } });
    expect(run.headed).toBe(true);
    await queue.enqueueRun(run);
    expect((await jobsFor(runId)).map((j) => j.name)).toEqual([QUEUES.runsHeaded]);
    const headed = await queue.boss.getQueue(QUEUES.runsHeaded);
    expect(headed?.policy).toBe("singleton");
  });

  it("nightly maintenance deletes run files past their retention, and keeps the runs and newer files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "storm-retention-"));
    try {
      const runId = await runner.start(await version(DIGEST), { trigger: "manual" });
      const file = async (name: string, daysOld: number) => {
        await mkdir(join(dir, runId), { recursive: true });
        await writeFile(join(dir, runId, name), "png");
        const dateCreated = new Date(Date.now() - daysOld * 86_400_000);
        return db.client.artifact.create({ data: { userId, runId, kind: "screenshot", path: `${runId}/${name}`, dateCreated } });
      };
      const old = await file("old.png", 91);
      const recent = await file("recent.png", 10);
      const retained = new JobHandlers(db.client, runner, queue, undefined, undefined, undefined, { artifacts: new ArtifactStore(dir), days: 90 });

      expect(await retained.maintain()).toBe(1);
      expect(await db.client.artifact.findUnique({ where: { artifactId: old.artifactId } })).toBeNull();
      expect(existsSync(join(dir, runId, "old.png"))).toBe(false);
      expect(await db.client.artifact.findUnique({ where: { artifactId: recent.artifactId } })).not.toBeNull();
      expect(existsSync(join(dir, runId, "recent.png"))).toBe(true);
      expect(await db.client.run.findUnique({ where: { runId } })).not.toBeNull();

      // 0 keeps everything.
      const forever = new JobHandlers(db.client, runner, queue, undefined, undefined, undefined, { artifacts: new ArtifactStore(dir), days: 0 });
      expect(await forever.maintain(new Date(Date.now() + 1000 * 86_400_000))).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe("schedules", () => {
    // M2-I8 (pg-boss side; the local-time computation is tested in @realentity/storm-queue)
    it("keeps pg-boss schedules in line with the enabled pipelines, in the pipeline's time zone", async () => {
      const scheduled = await pipelineOf(await version(DIGEST));
      const other = await pipelineOf(
        await version(DIGEST.replace("name: Digest", "name: Night").replace('"0 8 * * 1-5"', '"30 3 * * *", tz: UTC')),
      );
      const manual = await pipelineOf(await version(REPLY));
      await db.client.pipeline.updateMany({ data: { enabled: true } });

      await handlers.syncSchedules();
      const schedules = async () =>
        (await queue.boss.getSchedules())
          .filter((s) => s.name === QUEUES.trigger)
          .map((s) => ({ key: s.key, cron: s.cron, timezone: s.timezone }))
          .sort((a, b) => a.cron.localeCompare(b.cron));
      expect(await schedules()).toEqual([
        { key: scheduled, cron: "0 8 * * 1-5", timezone: "Europe/Sofia" },
        { key: other, cron: "30 3 * * *", timezone: "UTC" },
      ]);
      expect((await schedules()).some((s) => s.key === manual)).toBe(false);

      // Disabling removes the schedule.
      await db.client.pipeline.update({ where: { pipelineId: other }, data: { enabled: false } });
      await handlers.syncSchedules();
      expect(await schedules()).toEqual([{ key: scheduled, cron: "0 8 * * 1-5", timezone: "Europe/Sofia" }]);

      await db.client.pipeline.updateMany({ data: { enabled: false } });
      await handlers.syncSchedules();
      expect(await schedules()).toEqual([]);
    });

    it("a fired schedule starts a run on the current version and queues it", async () => {
      const pipelineVersionId = await version(DIGEST);
      const pipelineId = await pipelineOf(pipelineVersionId);
      await db.client.pipeline.update({ where: { pipelineId }, data: { enabled: true } });

      const runId = await handlers.trigger(pipelineId);
      const run = await db.client.run.findUniqueOrThrow({ where: { runId: runId! } });
      expect(run).toMatchObject({ pipelineVersionId, trigger: "schedule", status: "QUEUED", dryRun: false });
      expect((await jobsFor(run.runId)).map((j) => j.name)).toEqual([QUEUES.runs]);
    });

    it("a fired schedule does nothing for a disabled pipeline or while the kill switch is on", async () => {
      const pipelineId = await pipelineOf(await version(DIGEST));
      await expect(handlers.trigger(pipelineId)).resolves.toBeNull();

      await db.client.pipeline.update({ where: { pipelineId }, data: { enabled: true } });
      await db.client.userSetting.create({ data: { userId, paused: true, pausedAt: new Date() } });
      await expect(handlers.trigger(pipelineId)).resolves.toBeNull();
      expect(await db.client.run.count()).toBe(0);
    });
  });

  // M2-I3 across a restart: the new process recovers and queues what was in flight
  it("at startup, re-queues interrupted and queued runs", async () => {
    const interrupted = await runner.start(await version(DIGEST), { trigger: "manual" });
    await db.client.run.update({ where: { runId: interrupted }, data: { status: "RUNNING" } });
    const queued = await runner.start(await version(DIGEST.replace("name: Digest", "name: Later")), { trigger: "manual" });

    await handlers.recover();
    expect((await jobsFor(interrupted)).map((j) => j.name)).toEqual([QUEUES.runs]);
    expect((await jobsFor(queued)).map((j) => j.name)).toEqual([QUEUES.runs]);

    await handlers.consume({ concurrency: 1, pollingIntervalSeconds: 0.5 });
    await until(interrupted, "DONE");
    await until(queued, "DONE");
  });
});

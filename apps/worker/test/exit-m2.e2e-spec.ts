import { createPrismaConnection, type Prisma, type PrismaConnection } from "@realentity/storm-db";
import { emptyUsage, ModelRouter, type LlmClient, type LlmUsage, type StructuredRequest } from "@realentity/storm-llm";
import { JobQueue, QUEUES } from "@realentity/storm-queue";
import { defaultCatalog, PipelineCompiler } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { type z } from "zod";
import { JobHandlers } from "../src/jobs/job-handlers";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { coreSteps } from "../src/steps/core-steps";
import { createVersion } from "./support/test-steps";

/**
 * M2 exit criteria in one scenario, with the real step implementations (Claude and Telegram faked at their edge):
 * a scheduled pipeline (data + llm + gate + notify) runs from its trigger, pauses at the gate, resumes after my
 * decision, survives a worker restart, and is stopped by the kill switch. The gate is gate.review: the first
 * side-effect step (and with it gate.act in a real pipeline) arrives in M4.
 */
const DAILY = `
name: Daily jobs
trigger: { schedule: "0 8 * * 1-5" }
steps:
  - id: jobs
    type: data.filter
    with:
      items: [{ title: "Senior .NET", city: Sofia }, { title: "Lead .NET", city: Sofia }, { title: "PHP", city: Varna }]
      where: [{ field: city, op: eq, value: Sofia }]
  - id: score
    type: llm.score
    with: { items: "{{jobs.items}}", against: "Senior .NET roles" }
  - id: shortlist
    type: gate.review
    with: { items: "{{score.top}}" }
  - id: tell
    type: notify.telegram
    with: { text: "Picked: {{shortlist.selected}}" }
`;

/** Claude stand-in: scores items by position. */
class FakeClaude implements LlmClient {
  calls = 0;
  structured<S extends z.ZodObject>(request: StructuredRequest<S>): Promise<{ output: z.infer<S>; usage: LlmUsage }> {
    this.calls++;
    const indexes = [...request.prompt.matchAll(/\{"index":(\d+),/g)].map((m) => Number(m[1]));
    const output = request.schema.parse({ results: indexes.map((index) => ({ index, score: 90 - index * 10, reason: "fits" })) });
    return Promise.resolve({ output, usage: { ...emptyUsage(), models: ["claude-haiku-5-5"], calls: 1, costUsd: 0.0001 } });
  }
}

describe("M2 exit criteria", () => {
  let db: PrismaConnection;
  let userId: string;
  let queue: JobQueue;
  const sent: string[] = [];
  const claude = new FakeClaude();

  /** A worker process: its own runner and handlers over the shared database and queue. */
  function worker(): JobHandlers {
    const telegram = (_url: string | URL | Request, init?: RequestInit) => {
      sent.push((JSON.parse(init!.body as string) as { text: string }).text);
      return Promise.resolve(new Response(JSON.stringify({ ok: true })));
    };
    const steps = coreSteps({
      llm: claude,
      router: new ModelRouter(() => Promise.resolve(null)),
      telegram: { botToken: "123:test-token", chatId: "42" },
      fetch: telegram,
      mail: { fetch: () => Promise.reject(new Error("no mail here")), recent: () => Promise.reject(new Error("no mail here")), attachments: () => Promise.reject(new Error("no mail here")), send: () => Promise.reject(new Error("no mail here")) },
      prisma: db.client,
    });
    return new JobHandlers(db.client, new PipelineRunner(db.client, defaultCatalog(), new ExecutorRegistry(steps)), queue);
  }

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    queue = await JobQueue.start({ connectionString: process.env.DATABASE_URL!, role: "worker" });
    for (const name of Object.values(QUEUES)) await queue.boss.deleteAllJobs(name);
  });

  afterAll(async () => {
    for (const name of Object.values(QUEUES)) await queue.boss.offWork(name);
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.userSetting.deleteMany();
    await queue.stop();
    await db.close();
  });

  async function until(runId: string, status: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const run = await db.client.run.findUniqueOrThrow({ where: { runId } });
      if (run.status === status) return;
      if (Date.now() > deadline) throw new Error(`Run is ${run.status}, expected ${status}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /** What the api does on approval: final selection, hash, decision, and a job for the run. */
  async function approveSelection(runId: string, pick: (items: unknown[]) => unknown[]): Promise<void> {
    const proposal = await db.client.proposal.findFirstOrThrow({ where: { runId, status: "PENDING_REVIEW" } });
    const finalPayload = { items: pick((proposal.originalPayload as { items: unknown[] }).items) } as Prisma.InputJsonValue;
    await db.client.proposal.update({ where: { proposalId: proposal.proposalId }, data: { status: "APPROVED", finalPayload } });
    await queue.enqueueRun({ runId, headed: false });
  }

  it("runs on its schedule, pauses at the gate, resumes after my decision across a restart, and stops on the kill switch", async () => {
    const pipelineVersionId = await createVersion(db.client, userId, DAILY, new PipelineCompiler(defaultCatalog()));
    const { pipelineId } = await db.client.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId } });
    await db.client.pipeline.update({ where: { pipelineId }, data: { enabled: true } });

    // The schedule is registered in pg-boss, in Sofia time; firing it sends this job.
    const first = worker();
    await first.syncSchedules();
    expect((await queue.boss.getSchedules()).filter((s) => s.name === QUEUES.trigger)).toEqual([
      expect.objectContaining({ key: pipelineId, cron: "0 8 * * 1-5", timezone: "Europe/Sofia" }),
    ]);
    await first.consume({ concurrency: 1, pollingIntervalSeconds: 0.5 });
    await queue.boss.send(QUEUES.trigger, { pipelineId });

    // Data + LLM steps run, then the gate pauses the run.
    const deadline = Date.now() + 15_000;
    let runId: string | undefined;
    while (!runId && Date.now() < deadline) {
      runId = (await db.client.run.findFirst({ where: { trigger: "schedule" } }))?.runId;
      if (!runId) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await until(runId!, "WAITING_FOR_USER");
    const scored = await db.client.step.findFirstOrThrow({ where: { runId, stepKey: "score" } });
    expect(scored.llmUsage).toMatchObject({ costUsd: 0.0001 });
    expect(sent).toEqual([]);

    // The worker stops; I decide while it is down; a new worker process picks the run up.
    for (const name of Object.values(QUEUES)) await queue.boss.offWork(name);
    await approveSelection(runId!, (items) => items.slice(0, 1));
    const restarted = worker();
    await restarted.recover();
    await restarted.consume({ concurrency: 1, pollingIntervalSeconds: 0.5 });
    await until(runId!, "DONE");
    expect(sent).toHaveLength(1);
    // Only the item I kept (key order is jsonb's).
    expect(JSON.parse(sent[0].replace("Picked: ", ""))).toEqual([{ city: "Sofia", title: "Senior .NET", score: 90, scoreReason: "fits" }]);
    const steps = await db.client.step.findMany({ where: { runId } });
    expect(
      steps
        .filter((s) => s.status === "DONE")
        .map((s) => s.stepKey)
        .sort(),
    ).toEqual(["jobs", "score", "shortlist", "tell"]);

    // Next morning: the run waits at the gate, the kill switch goes on, and my late approval acts on nothing.
    await queue.boss.send(QUEUES.trigger, { pipelineId });
    let second: string | undefined;
    while (!second) {
      second = (await db.client.run.findFirst({ where: { trigger: "schedule", runId: { not: runId } } }))?.runId;
      if (!second) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await until(second, "WAITING_FOR_USER");
    await approveSelection(second, (items) => items);
    await db.client.userSetting.create({ data: { userId, paused: true, pausedAt: new Date() } });
    await until(second, "ABORTED");
    expect((await db.client.run.findUniqueOrThrow({ where: { runId: second } })).summary).toBe("Stopped by the kill switch");
    expect(sent).toHaveLength(1);

    // While it is on, the schedule starts nothing.
    await expect(restarted.trigger(pipelineId)).resolves.toBeNull();
  });
});

import { payloadHash } from "@ai-me/crypto";
import { createPrismaConnection, type Prisma, type PrismaConnection, type Proposal } from "@ai-me/db";
import { emptyUsage } from "@ai-me/llm";
import { TestEnvironment } from "@ai-me/testing";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { RunControls } from "../src/runner/run-controls";
import { ExecutorRegistry, type StepExecutor } from "../src/runner/step-executor";
import { catalog, Counting, createVersion, JOBS } from "./support/test-steps";

describe("PipelineRunner", () => {
  let db: PrismaConnection;
  let userId: string;
  let search: Counting, note: Counting, send: Counting, submit: Counting, telegram: Counting;
  let runner: PipelineRunner;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(() => {
    search = new Counting("test.search", () => ({ items: JOBS }));
    note = new Counting("test.note", (input) => ({ text: `note: ${String(input.text)}` }));
    send = new Counting("test.send", () => ({ messageId: "m-1" }));
    submit = new Counting("test.submit", (input) => ({ confirmation: `applied via ${String(input.url)}` }));
    telegram = new Counting("notify.telegram", () => ({ sent: true }));
    runner = new PipelineRunner(db.client, catalog, new ExecutorRegistry([search, note, send, submit, telegram]));
  });

  afterEach(async () => {
    // Runs keep their pipeline version (no cascade): delete runs first.
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  const version = (source: string): Promise<string> => createVersion(db.client, userId, source);

  const proposals = (runId: string): Promise<Proposal[]> =>
    db.client.proposal.findMany({ where: { runId }, orderBy: [{ itemIndex: "asc" }] });

  /** What the api does on approval (M3 inbox): final payload, its hash, approved new targets. */
  async function approve(
    proposal: Proposal,
    edit?: (p: Record<string, unknown>) => Record<string, unknown>,
    approvedNewTargets: string[] = [],
  ) {
    const finalPayload = edit
      ? edit(proposal.originalPayload as Record<string, unknown>)
      : (proposal.originalPayload as Record<string, unknown>);
    await db.client.proposal.update({
      where: { proposalId: proposal.proposalId },
      data: {
        status: "APPROVED",
        finalPayload: finalPayload as Prisma.InputJsonValue,
        payloadHash: payloadHash(finalPayload),
        approvedNewTargets,
      },
    });
  }

  const reject = (proposal: Proposal) =>
    db.client.proposal.update({ where: { proposalId: proposal.proposalId }, data: { status: "REJECTED" } });

  const DIGEST = `
name: Digest
steps:
  - id: search
    type: test.search
    with: { query: dotnet }
  - id: summary
    type: test.note
    with: { text: "Jobs: {{search.items}}" }
  - id: tell
    type: notify.telegram
    with: { text: "{{summary.text}}" }
`;

  // M2-I1
  it("runs a pipeline end to end and records every step's input and output", async () => {
    const runId = await runner.start(await version(DIGEST), { trigger: "manual" });
    await expect(runner.advance(runId)).resolves.toBe("DONE");

    const steps = await db.client.step.findMany({ where: { runId }, orderBy: { startedAt: "asc" } });
    expect(steps.map((s) => [s.stepKey, s.status])).toEqual([
      ["search", "DONE"],
      ["summary", "DONE"],
      ["tell", "DONE"],
    ]);
    expect(steps[1]?.input).toEqual({ text: `Jobs: ${JSON.stringify(JOBS)}` });
    expect(telegram.calls).toEqual([{ text: `note: Jobs: ${JSON.stringify(JOBS)}` }]);
    const run = await db.client.run.findUniqueOrThrow({ where: { runId } });
    expect(run.finishedAt).not.toBeNull();
  });

  const APPLY = `
name: Apply
policy: { allowedDomains: [jobs.example.org] }
steps:
  - id: search
    type: test.search
    with: { query: dotnet }
  - id: letter
    type: test.note
    forEach: "{{search.items}}"
    with: { text: "Dear {{item.recruiter}}, about {{item.title}}" }
  - id: apply
    type: test.submit
    forEach: "{{search.items}}"
    with: { url: "{{item.applyUrl}}", letter: "{{letter.text}}" }
`;

  // M2-I2, M2-T10
  it("fans out per item: one step and one proposal per item, aligned values, waits for every decision", async () => {
    const runId = await runner.start(await version(APPLY), { trigger: "manual" });
    await expect(runner.advance(runId)).resolves.toBe("WAITING_FOR_USER");

    const [p0, p1] = await proposals(runId);
    expect([p0?.itemIndex, p1?.itemIndex]).toEqual([0, 1]);
    expect(p0?.originalPayload).toEqual({ url: JOBS[0].applyUrl, letter: "note: Dear ana@acme.test, about Senior .NET" });
    expect(p1?.targets).toEqual([{ field: "url", kind: "domain", value: "careers.other.test", basis: "provenance", isNew: true }]);
    expect(submit.calls).toHaveLength(0);

    await approve(p0);
    await expect(runner.advance(runId)).resolves.toBe("WAITING_FOR_USER");
    expect(submit.calls.map((c) => c.url)).toEqual([JOBS[0].applyUrl]);

    await approve(p1);
    await expect(runner.advance(runId)).resolves.toBe("DONE");
    expect(submit.calls.map((c) => c.url)).toEqual([JOBS[0].applyUrl, JOBS[1].applyUrl]);
    expect(search.calls).toHaveLength(1);
    expect(note.calls).toHaveLength(2);
    await expect(proposals(runId)).resolves.toEqual([
      expect.objectContaining({ status: "DONE" }),
      expect.objectContaining({ status: "DONE" }),
    ]);
  });

  it("skips an item's side effect when I reject it, and acts on the others", async () => {
    const runId = await runner.start(await version(APPLY), { trigger: "manual" });
    await runner.advance(runId);
    const [p0, p1] = await proposals(runId);
    await reject(p0);
    await approve(p1);
    await expect(runner.advance(runId)).resolves.toBe("DONE");
    expect(submit.calls.map((c) => c.url)).toEqual([JOBS[1].applyUrl]);
    const applySteps = await db.client.step.findMany({ where: { runId, stepKey: "apply" }, orderBy: { itemIndex: "asc" } });
    expect(applySteps.map((s) => s.status)).toEqual(["SKIPPED", "DONE"]);
  });

  it("uses my edited payload, not the original", async () => {
    const runId = await runner.start(await version(APPLY), { trigger: "manual" });
    await runner.advance(runId);
    const [p0, p1] = await proposals(runId);
    await approve(p0, (p) => ({ ...p, letter: "My own words" }));
    await reject(p1);
    await runner.advance(runId);
    expect(submit.calls).toEqual([{ url: JOBS[0].applyUrl, letter: "My own words" }]);
  });

  it("lets me pick items at gate.review; the selection can only drop items", async () => {
    const runId = await runner.start(
      await version(`
name: Pick
steps:
  - id: search
    type: test.search
    with: { query: dotnet }
  - id: pick
    type: gate.review
    with: { items: "{{search.items}}" }
  - id: tell
    type: notify.telegram
    forEach: "{{pick.selected}}"
    with: { text: "{{item.title}}" }
`),
      { trigger: "manual" },
    );
    await expect(runner.advance(runId)).resolves.toBe("WAITING_FOR_USER");
    const [review] = await proposals(runId);
    await approve(review, () => ({ items: [JOBS[1], { title: "Injected", applyUrl: "https://evil.test", recruiter: "x@evil.test" }] }));
    await expect(runner.advance(runId)).resolves.toBe("DONE");
    expect(telegram.calls).toEqual([{ text: "Lead .NET" }]);
  });

  // M2-I3
  it("resumes after a crash from the last completed step; nothing that finished runs again", async () => {
    const runId = await runner.start(await version(DIGEST), { trigger: "manual" });
    await runner.advance(runId);
    // Simulate a worker killed while "summary" was running.
    await db.client.run.update({ where: { runId }, data: { status: "RUNNING", finishedAt: null } });
    await db.client.step.updateMany({ where: { runId, stepKey: "summary" }, data: { status: "RUNNING" } });
    await db.client.step.deleteMany({ where: { runId, stepKey: "tell" } });

    await expect(runner.recoverInterrupted()).resolves.toEqual([runId]);
    await expect(runner.advance(runId)).resolves.toBe("DONE");
    expect(search.calls).toHaveLength(1);
    expect(note.calls).toHaveLength(2); // the interrupted step re-ran once
    expect(telegram.calls).toHaveLength(2); // once before the "crash", once after (it had been deleted)
  });

  it("does not re-run a side-effect step that was interrupted", async () => {
    const runId = await runner.start(await version(APPLY), { trigger: "manual" });
    await runner.advance(runId);
    for (const p of await proposals(runId)) await approve(p);
    await runner.advance(runId);
    await db.client.run.update({ where: { runId }, data: { status: "RUNNING", finishedAt: null } });
    await db.client.step.updateMany({ where: { runId, stepKey: "apply", itemIndex: 1 }, data: { status: "RUNNING" } });

    await expect(runner.recoverInterrupted()).resolves.toEqual([]);
    const run = await db.client.run.findUniqueOrThrow({ where: { runId } });
    expect(run.status).toBe("FAILED");
    await expect(runner.advance(runId)).resolves.toBe("FAILED");
    expect(submit.calls).toHaveLength(2);
  });

  // M2-I4
  it("retries a failing step as configured, but never a side-effect step", async () => {
    const runId = await runner.start(await version(DIGEST.replace("type: test.note", "type: test.note\n    retries: 2")), {
      trigger: "manual",
    });
    note.failuresLeft = 2;
    await expect(runner.advance(runId)).resolves.toBe("DONE");
    expect(note.calls).toHaveLength(3);

    const sendRun = await runner.start(
      await version(`
name: Send
steps:
  - id: send
    type: test.send
    with: { to: "me@example.com", body: hi }
`),
      { trigger: "manual" },
    );
    await runner.advance(sendRun);
    await approve((await proposals(sendRun))[0]);
    send.failuresLeft = 1;
    await expect(runner.advance(sendRun)).resolves.toBe("FAILED");
    expect(send.calls).toHaveLength(1);
    await expect(proposals(sendRun)).resolves.toEqual([expect.objectContaining({ status: "FAILED" })]);
  });

  it("fails a step after its retries and records the error", async () => {
    const runId = await runner.start(await version(DIGEST), { trigger: "manual" });
    note.failuresLeft = 5;
    await expect(runner.advance(runId)).resolves.toBe("FAILED");
    const failed = await db.client.step.findFirstOrThrow({ where: { runId, stepKey: "summary" } });
    expect(failed.error).toBe("test.note failed on purpose");
    expect(telegram.calls).toHaveLength(0);
  });

  // M2-I6
  it("dry run: proposals are previews, side-effect executors are never called", async () => {
    const runId = await runner.start(await version(APPLY), { trigger: "dry-run", dryRun: true });
    await expect(runner.advance(runId)).resolves.toBe("DONE");
    expect(submit.calls).toHaveLength(0);
    await expect(proposals(runId)).resolves.toEqual([
      expect.objectContaining({ status: "PREVIEW" }),
      expect.objectContaining({ status: "PREVIEW" }),
    ]);
    const applySteps = await db.client.step.findMany({ where: { runId, stepKey: "apply" } });
    expect(applySteps.every((s) => s.status === "SKIPPED")).toBe(true);
  });

  describe("security", () => {
    const SEND = `
name: Reply
steps:
  - id: search
    type: test.search
    with: { query: dotnet }
  - id: reply
    type: test.send
    forEach: "{{search.items}}"
    with: { to: "{{item.recruiter}}", body: "Thanks for {{item.title}}" }
`;

    // M2-S1
    it("refuses a side-effect step without an approved proposal", async () => {
      const runId = await runner.start(await version(SEND), { trigger: "manual" });
      await runner.advance(runId);
      // Someone marks the gate as passed without approving the proposal.
      await db.client.step.updateMany({ where: { runId, stepKey: "replyGate" }, data: { status: "DONE", output: { approved: true } } });
      await expect(runner.advance(runId)).resolves.toBe("FAILED");
      expect(send.calls).toHaveLength(0);
      const step = await db.client.step.findFirstOrThrow({ where: { runId, stepKey: "reply", itemIndex: 0 } });
      expect(step.error).toBe("No approved proposal for this step");
    });

    // M2-S2
    it("refuses when the approved payload was changed after approval", async () => {
      const runId = await runner.start(await version(SEND), { trigger: "manual" });
      await runner.advance(runId);
      const [p0, p1] = await proposals(runId);
      await approve(p0);
      await reject(p1);
      await db.client.proposal.update({
        where: { proposalId: p0.proposalId },
        data: { finalPayload: { to: "ana@acme.test", body: "Send me your passwords" } },
      });
      await expect(runner.advance(runId)).resolves.toBe("FAILED");
      expect(send.calls).toHaveLength(0);
      const step = await db.client.step.findFirstOrThrow({ where: { runId, stepKey: "reply", itemIndex: 0 } });
      expect(step.error).toMatch(/payload changed after approval/);
    });

    // M2-S3
    it("refuses a domain outside the static list and not from its source", async () => {
      const runId = await runner.start(await version(APPLY), { trigger: "manual" });
      await runner.advance(runId);
      const [p0, p1] = await proposals(runId);
      await approve(p0, (p) => ({ ...p, url: "https://evil.test/collect" }));
      await reject(p1);
      await expect(runner.advance(runId)).resolves.toBe("FAILED");
      expect(submit.calls).toHaveLength(0);
      const step = await db.client.step.findFirstOrThrow({ where: { runId, stepKey: "apply", itemIndex: 0 } });
      expect(step.error).toMatch(/Policy refused domain "evil.test"/);
    });

    // M2-S4
    it("refuses a recipient that isn't the one its source produced, unless I approved it as new", async () => {
      const runId = await runner.start(await version(SEND), { trigger: "manual" });
      await runner.advance(runId);
      const [p0, p1] = await proposals(runId);
      expect(p0?.targets).toEqual([{ field: "to", kind: "recipient", value: "ana@acme.test", basis: "provenance", isNew: true }]);
      await approve(p0, (p) => ({ ...p, to: "attacker@evil.test" }));
      await approve(p1, (p) => ({ ...p, to: "boss@other.test" }), ["boss@other.test"]);
      await expect(runner.advance(runId)).resolves.toBe("FAILED");
      expect(send.calls).toHaveLength(0);
      const step = await db.client.step.findFirstOrThrow({ where: { runId, stepKey: "reply", itemIndex: 0 } });
      expect(step.error).toMatch(/Policy refused recipient "attacker@evil.test"/);

      // The second item's new recipient was approved explicitly: allowed.
      const runId2 = await runner.start(await version(SEND.replace("name: Reply", "name: Reply2")), { trigger: "manual" });
      await runner.advance(runId2);
      const [q0, q1] = await proposals(runId2);
      await reject(q0);
      await approve(q1, (p) => ({ ...p, to: "boss@other.test" }), ["boss@other.test"]);
      await expect(runner.advance(runId2)).resolves.toBe("DONE");
      expect(send.calls.map((c) => c.to)).toEqual(["boss@other.test"]);
    });
  });

  describe("run controls", () => {
    const REPLY = `
name: Replies
limits: { test.send: 1/day }
steps:
  - id: search
    type: test.search
    with: { query: dotnet }
  - id: reply
    type: test.send
    forEach: "{{search.items}}"
    with: { to: "{{item.recruiter}}", body: "Thanks for {{item.title}}" }
`;

    afterEach(async () => {
      await db.client.userSetting.deleteMany();
    });

    const engageKillSwitch = () =>
      db.client.userSetting.upsert({
        where: { userId },
        create: { userId, paused: true, pausedAt: new Date() },
        update: { paused: true, pausedAt: new Date() },
      });

    // M2-S5 (runner side; the api aborts queued and waiting runs)
    it("kill switch: a running run stops at the next step boundary", async () => {
      note = new Counting("test.note", async (input) => {
        await engageKillSwitch();
        return { text: String(input.text) };
      });
      runner = new PipelineRunner(db.client, catalog, new ExecutorRegistry([search, note, send, submit, telegram]));
      const runId = await runner.start(await version(DIGEST), { trigger: "manual" });

      await expect(runner.advance(runId)).resolves.toBe("ABORTED");
      expect(telegram.calls).toHaveLength(0);
      const run = await db.client.run.findUniqueOrThrow({ where: { runId } });
      expect(run.summary).toBe("Stopped by the kill switch");
      expect(run.finishedAt).not.toBeNull();
      const steps = await db.client.step.findMany({ where: { runId } });
      expect(steps.map((s) => [s.stepKey, s.status]).sort()).toEqual([
        ["search", "DONE"],
        ["summary", "DONE"],
      ]);
    });

    // M2-S5
    it("kill switch: an approved side effect does not execute, and open proposals expire", async () => {
      const runId = await runner.start(await version(APPLY), { trigger: "manual" });
      await runner.advance(runId);
      const [p0, p1] = await proposals(runId);
      await approve(p0);
      await engageKillSwitch();

      await expect(runner.advance(runId)).resolves.toBe("ABORTED");
      expect(submit.calls).toHaveLength(0);
      expect((await proposals(runId)).map((p) => p.status)).toEqual(["EXPIRED", "EXPIRED"]);
      expect(p1?.status).toBe("PENDING_REVIEW");
      // An aborted run is never claimed again.
      await expect(runner.advance(runId)).resolves.toBe("ABORTED");
    });

    // M2-I5
    it("rate limit: further side effects wait for the next window, then continue", async () => {
      const runId = await runner.start(await version(REPLY), { trigger: "manual" });
      await runner.advance(runId);
      for (const p of await proposals(runId)) await approve(p);

      await expect(runner.advance(runId)).resolves.toBe("QUEUED");
      expect(send.calls.map((c) => c.to)).toEqual(["ana@acme.test"]);
      const first = await db.client.step.findFirstOrThrow({ where: { runId, stepKey: "reply", itemIndex: 0 } });
      let run = await db.client.run.findUniqueOrThrow({ where: { runId } });
      expect(run.resumeAt?.getTime()).toBe(first.startedAt!.getTime() + 86_400_000);
      expect(run.summary).toMatch(/Rate limit of test.send reached/);

      // Still inside the window: nothing more is sent.
      await expect(runner.advance(runId)).resolves.toBe("QUEUED");
      expect(send.calls).toHaveLength(1);

      // A day later.
      await db.client.step.update({ where: { stepId: first.stepId }, data: { startedAt: new Date(Date.now() - 86_400_000 - 1000) } });
      await expect(runner.advance(runId)).resolves.toBe("DONE");
      expect(send.calls.map((c) => c.to)).toEqual(["ana@acme.test", "bob@other.test"]);
      run = await db.client.run.findUniqueOrThrow({ where: { runId } });
      expect(run.resumeAt).toBeNull();
    });

    // M2-I5
    it("rate limit: the global limit from settings counts every pipeline's executions", async () => {
      await db.client.userSetting.create({ data: { userId, rateLimits: { "test.send": "1/hour" } } });
      const unlimited = REPLY.replace("limits: { test.send: 1/day }\n", "");
      const first = await runner.start(await version(unlimited), { trigger: "manual" });
      await runner.advance(first);
      const [p0, p1] = await proposals(first);
      await approve(p0);
      await reject(p1);
      await expect(runner.advance(first)).resolves.toBe("DONE");

      const second = await runner.start(await version(unlimited.replace("name: Replies", "name: Other")), { trigger: "manual" });
      await runner.advance(second);
      const [q0, q1] = await proposals(second);
      await approve(q0);
      await reject(q1);
      await expect(runner.advance(second)).resolves.toBe("QUEUED");
      expect(send.calls).toHaveLength(1);
    });

    const SUMMARY = `
name: Summary
steps:
  - id: search
    type: test.search
    with: { query: dotnet }
  - id: summary
    type: llm.summarize
    with: { content: "{{search.items}}" }
`;

    // M2-T16, M2-U6 (runner side)
    it("saves each step's LLM usage; an answer that doesn't match the step's output saves no output, but its cost", async () => {
      const spend = { ...emptyUsage(), models: ["claude-sonnet-5-5"], calls: 1, inputTokens: 900, outputTokens: 100, costUsd: 0.0028 };
      let answer: unknown = { summary: "two jobs" };
      const summarize: StepExecutor = {
        type: "llm.summarize",
        execute: (_input, context) => {
          context.recordUsage(spend);
          return Promise.resolve(answer);
        },
      };
      runner = new PipelineRunner(db.client, catalog, new ExecutorRegistry([search, summarize]));

      const ok = await runner.start(await version(SUMMARY), { trigger: "manual" });
      await expect(runner.advance(ok)).resolves.toBe("DONE");
      const done = await db.client.step.findFirstOrThrow({ where: { runId: ok, stepKey: "summary" } });
      expect(done.llmUsage).toEqual(spend);

      answer = { summary: 42 };
      const bad = await runner.start(await version(SUMMARY.replace("name: Summary", "name: Bad")), { trigger: "manual" });
      await expect(runner.advance(bad)).resolves.toBe("FAILED");
      const failed = await db.client.step.findFirstOrThrow({ where: { runId: bad, stepKey: "summary" } });
      expect(failed).toMatchObject({ status: "FAILED", output: null, llmUsage: spend });
      expect(failed.error).toMatch(/summary/);

      // Both calls count toward this month's spend.
      await expect(new RunControls(db.client).monthlySpendUsd(userId)).resolves.toBeCloseTo(0.0056, 6);
    });

    // M2-I7
    it("budget: once the monthly budget is spent, non-essential pipelines stop before LLM steps; essential ones continue", async () => {
      const summarize = new Counting("llm.summarize", () => ({ summary: "two jobs" }));
      runner = new PipelineRunner(db.client, catalog, new ExecutorRegistry([search, summarize]));
      await db.client.userSetting.create({ data: { userId, monthlyBudgetUsd: 1 } });

      // Spend this month: 1.20 USD.
      const spent = await runner.start(await version(SUMMARY.replace("name: Summary", "name: Spent")), { trigger: "manual" });
      await db.client.step.create({
        data: {
          runId: spent,
          stepKey: "summary",
          type: "llm.summarize",
          status: "DONE",
          startedAt: new Date(),
          llmUsage: { costUsd: 1.2 },
        },
      });
      await db.client.run.update({ where: { runId: spent }, data: { status: "DONE" } });

      const runId = await runner.start(await version(SUMMARY), { trigger: "manual" });
      await expect(runner.advance(runId)).resolves.toBe("ABORTED");
      expect(summarize.calls).toHaveLength(0);
      expect((await db.client.run.findUniqueOrThrow({ where: { runId } })).summary).toMatch(/Monthly LLM budget reached/);

      const essentialId = await version(SUMMARY.replace("name: Summary", "name: Essential"));
      const { pipelineId } = await db.client.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId: essentialId } });
      await db.client.pipeline.update({ where: { pipelineId }, data: { essential: true } });
      const essential = await runner.start(essentialId, { trigger: "manual" });
      await expect(runner.advance(essential)).resolves.toBe("DONE");
      expect(summarize.calls).toHaveLength(1);
    });
  });

  // M2-T10
  it("does not lose a decision made while the run is advancing", async () => {
    const runId = await runner.start(await version(APPLY), { trigger: "manual" });
    await runner.advance(runId);
    const [p0, p1] = await proposals(runId);
    await approve(p0);
    // The second decision lands while the first approved item is executing.
    submit = new Counting("test.submit", async (input) => {
      if (submit.calls.length === 1) await approve(p1, undefined, ["careers.other.test"]);
      return { confirmation: `applied via ${String(input.url)}` };
    });
    runner = new PipelineRunner(db.client, catalog, new ExecutorRegistry([search, note, send, submit, telegram]));

    await expect(runner.advance(runId)).resolves.toBe("DONE");
    expect(submit.calls.map((c) => c.url)).toEqual([JOBS[0].applyUrl, JOBS[1].applyUrl]);
  });

  it("never advances the same run twice at once", async () => {
    const runId = await runner.start(await version(DIGEST), { trigger: "manual" });
    const results = await Promise.all([runner.advance(runId), runner.advance(runId)]);
    expect(results.sort()).toEqual(["DONE", "RUNNING"]);
    expect(search.calls).toHaveLength(1);
  });
});

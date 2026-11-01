import { KeyRing, seal } from "@ai-me/crypto";
import { createPrismaConnection, type PrismaConnection, type RunStatus } from "@ai-me/db";
import { JobQueue, QUEUES, type EventJob } from "@ai-me/queue";
import { TestEnvironment } from "@ai-me/testing";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { JobHandlers } from "../src/jobs/job-handlers";
import { ProposalNotifier } from "../src/jobs/proposal-notifier";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { MAX_CHAIN_DEPTH, Triggers } from "../src/runner/triggers";
import { catalog, Counting, createVersion, JOBS } from "./support/test-steps";

const SEARCH = `
name: Search
steps:
  - id: search
    type: test.search
    with: { query: dotnet }
`;

const AFTER_SEARCH = `
name: After search
trigger: { on: run.finished, pipeline: Search }
steps:
  - id: note
    type: test.note
    with: { text: "{{trigger.pipeline}} {{trigger.status}}: {{trigger.outputs.search.items}}" }
`;

const LOOP = `
name: Loop
trigger: { on: run.finished, pipeline: Loop }
steps:
  - id: note
    type: test.note
    with: { text: "again" }
`;

const HOOK = (auth: string) => `
name: Hook
trigger: { webhook: ${auth} }
steps:
  - id: note
    type: test.note
    with: { text: "{{trigger.event}}: {{trigger.body.ref}}" }
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

/** The Bot API, as far as the notifier uses it: every call kept, each message given the next id. */
class FakeTelegram {
  calls: { method: string; body: Record<string, unknown> }[] = [];
  readonly fetch: typeof fetch = (input, init) => {
    const method = (input as string).split("/").pop()!;
    this.calls.push({ method, body: JSON.parse(init?.body as string) as Record<string, unknown> });
    return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: this.calls.length } })));
  };
}

describe("M12: event and webhook triggers", () => {
  let db: PrismaConnection;
  let userId: string;
  let queue: JobQueue;
  let keys: KeyRing;
  let search: Counting, note: Counting, send: Counting;
  let runner: PipelineRunner;
  let triggers: Triggers;
  let telegram: FakeTelegram;
  let handlers: JobHandlers;
  let events: EventJob[];

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    queue = await JobQueue.start({ connectionString: process.env.DATABASE_URL!, role: "worker" });
    keys = KeyRing.fromEnv(process.env);
  });

  beforeEach(async () => {
    events = [];
    search = new Counting("test.search", () => ({ items: JOBS }));
    note = new Counting("test.note", (input) => ({ text: input.text }));
    send = new Counting("test.send", () => ({ messageId: "m-1" }));
    runner = new PipelineRunner(db.client, catalog, new ExecutorRegistry([search, note, send]), undefined, undefined, undefined, async (event) => {
      events.push(event);
      await queue.enqueueEvent(event);
    });
    triggers = new Triggers(db.client, runner, queue, keys);
    telegram = new FakeTelegram();
    const notifier = new ProposalNotifier(db.client, { botToken: "1:x", chatId: "42" }, "https://aime.test", telegram.fetch);
    handlers = new JobHandlers(db.client, runner, queue, undefined, undefined, undefined, undefined, { triggers, notifier });
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

  /** Saved and enabled, as a pipeline that runs on its trigger. */
  async function enabled(source: string): Promise<string> {
    const versionId = await createVersion(db.client, userId, source);
    const { pipelineId } = await db.client.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId: versionId } });
    await db.client.pipeline.update({ where: { pipelineId }, data: { enabled: true } });
    return versionId;
  }

  async function runsOf(name: string) {
    return db.client.run.findMany({ where: { pipelineVersion: { pipeline: { name } } }, orderBy: { startedAt: "asc" } });
  }

  async function until(check: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  const finished = (name: string, status: RunStatus = "DONE") => async () => (await runsOf(name)).some((r) => r.status === status);

  it("M12-I1: Search finishes → After search runs with its outputs in {{trigger}}", async () => {
    await handlers.consume({ concurrency: 1, pollingIntervalSeconds: 0.5 });
    await enabled(AFTER_SEARCH);
    const runId = await runner.start(await enabled(SEARCH), { trigger: "manual" });
    await queue.enqueueRun({ runId, headed: false });

    await until(finished("After search"), "After search to finish");
    const [after] = await runsOf("After search");
    expect(after).toMatchObject({ trigger: "event", chainDepth: 1, triggeredByRunId: runId });
    expect(note.calls).toEqual([{ text: `Search DONE: ${JSON.stringify(JOBS)}` }]);
  });

  it("starts only enabled pipelines whose filter matches, and nothing with the kill switch on", async () => {
    const versionId = await createVersion(db.client, userId, AFTER_SEARCH);
    const source = { runId: "00000000-0000-4000-8000-000000000001", pipelineId: "00000000-0000-4000-8000-000000000002", depth: 0 };
    const event = (data: Record<string, unknown>): EventJob => ({ userId, event: "run.finished", data, source });
    // Saved but not enabled.
    expect(await triggers.fire(event({ pipeline: "Search", status: "DONE", outputs: {} }))).toEqual([]);

    const { pipelineId } = await db.client.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId: versionId } });
    await db.client.pipeline.update({ where: { pipelineId }, data: { enabled: true } });
    expect(await triggers.fire(event({ pipeline: "Search", status: "FAILED", outputs: {} }))).toEqual([]);
    expect(await triggers.fire(event({ pipeline: "Other", status: "DONE", outputs: {} }))).toEqual([]);

    await db.client.userSetting.create({ data: { userId, paused: true } });
    expect(await triggers.fire(event({ pipeline: "Search", status: "DONE", outputs: {} }))).toEqual([]);
    await db.client.userSetting.update({ where: { userId }, data: { paused: false } });
    expect(await triggers.fire(event({ pipeline: "Search", status: "DONE", outputs: {} }))).toHaveLength(1);
  });

  it("M12-S5: a pipeline never runs on its own event, and chains stop at depth 3", async () => {
    await handlers.consume({ concurrency: 1, pollingIntervalSeconds: 0.5 });
    const loop = await enabled(LOOP);
    const runId = await runner.start(loop, { trigger: "manual" });
    await queue.enqueueRun({ runId, headed: false });
    await until(async () => events.length === 1, "the run.finished event");
    // Let the event be handled: it must start nothing.
    await until(async () => (await db.client.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pgboss.job WHERE name = ${QUEUES.events} AND state = 'completed'`)[0].n > 0n, "the event to be handled");
    expect(await runsOf("Loop")).toHaveLength(1);

    await enabled(AFTER_SEARCH);
    const deep = (depth: number): EventJob => ({
      userId,
      event: "run.finished",
      data: { pipeline: "Search", status: "DONE", outputs: {} },
      source: { runId, pipelineId: "00000000-0000-4000-8000-000000000002", depth },
    });
    expect(await triggers.fire(deep(MAX_CHAIN_DEPTH))).toEqual([]);
    const [started] = await triggers.fire(deep(MAX_CHAIN_DEPTH - 1));
    expect(await db.client.run.findUniqueOrThrow({ where: { runId: started } })).toMatchObject({ chainDepth: MAX_CHAIN_DEPTH });
  });

  it("dry runs trigger nothing", async () => {
    await enabled(AFTER_SEARCH);
    const runId = await runner.start(await enabled(SEARCH), { trigger: "dry-run", dryRun: true });
    expect(await runner.advance(runId)).toBe("DONE");
    expect(events).toEqual([]);
  });

  describe("webhooks", () => {
    async function hook(auth: "hmac-sha256" | "token"): Promise<{ webhookId: string; secret: string }> {
      const versionId = await enabled(HOOK(auth));
      const { pipelineId } = await db.client.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId: versionId } });
      const webhookId = randomBytes(32).toString("base64url");
      const secret = randomBytes(32).toString("base64url");
      await db.client.webhook.create({
        data: { webhookId, userId, pipelineId, secretHash: createHash("sha256").update(secret).digest("hex"), ...seal(keys, webhookId, secret) },
      });
      return { webhookId, secret };
    }

    const call = (webhookId: string, body: string, signature: string | null) => ({
      webhookId,
      body: Buffer.from(body).toString("base64"),
      signature,
      event: "push",
      receivedAt: new Date().toISOString(),
    });

    it("M12-I2: a GitHub-signed call starts a run with the body as {{trigger.body}}", async () => {
      const { webhookId, secret } = await hook("hmac-sha256");
      const body = JSON.stringify({ ref: "refs/heads/main" });
      const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
      const runId = await triggers.webhook(call(webhookId, body, signature));
      expect(runId).not.toBeNull();
      expect(await runner.advance(runId!)).toBe("DONE");
      expect(note.calls).toEqual([{ text: "push: refs/heads/main" }]);
      expect(await db.client.run.findUniqueOrThrow({ where: { runId: runId! } })).toMatchObject({ trigger: "webhook" });
      expect((await db.client.webhook.findUniqueOrThrow({ where: { webhookId } })).lastCalledAt).not.toBeNull();
    });

    it("M12-S1: a wrong or missing signature, or another body under a right one, starts nothing", async () => {
      const { webhookId, secret } = await hook("hmac-sha256");
      const body = JSON.stringify({ ref: "refs/heads/main" });
      const signed = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
      expect(await triggers.webhook(call(webhookId, body, null))).toBeNull();
      expect(await triggers.webhook(call(webhookId, body, `sha256=${"0".repeat(64)}`))).toBeNull();
      expect(await triggers.webhook(call(webhookId, JSON.stringify({ ref: "refs/heads/evil" }), signed))).toBeNull();
      expect(await db.client.run.count()).toBe(0);
    });

    it("starts nothing for a disabled pipeline or with the kill switch on", async () => {
      const { webhookId } = await hook("token");
      await db.client.userSetting.create({ data: { userId, paused: true } });
      expect(await triggers.webhook(call(webhookId, "{}", null))).toBeNull();
      await db.client.userSetting.update({ where: { userId }, data: { paused: false } });
      await db.client.pipeline.updateMany({ data: { enabled: false } });
      expect(await triggers.webhook(call(webhookId, "{}", null))).toBeNull();
      expect(await db.client.run.count()).toBe(0);
    });
  });

  describe("M12-T4: proposals on the AI ME bot", () => {
    it("tells each new proposal once, with Approve / Reject / Open bound to its payload", async () => {
      const runId = await runner.start(await createVersion(db.client, userId, REPLY), { trigger: "manual" });
      expect(await handlers.advance(runId)).toBe("WAITING_FOR_USER");
      expect(await handlers.advance(runId)).toBe("WAITING_FOR_USER");

      const messages = telegram.calls.filter((c) => c.method === "sendMessage");
      expect(messages).toHaveLength(2);
      const proposals = await db.client.proposal.findMany({ where: { runId }, orderBy: { itemIndex: "asc" } });
      expect(proposals.map((p) => p.telegramMessageId)).toEqual([1, 2]);
      expect(messages[0].body.text).toContain("approve test.send (item 1)?\nTarget: ana@acme.test");
      expect(messages[0].body.text).toContain("body: Thanks for Senior .NET");
      const buttons = (messages[0].body.reply_markup as { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] }).inline_keyboard[0];
      expect(buttons.map((b) => b.text)).toEqual(["Approve", "Reject", "Open"]);
      expect(buttons[0].callback_data).toMatch(new RegExp(`^a:${proposals[0].proposalId}:[0-9a-f]{16}$`));
      expect(buttons[2].url).toBe(`https://aime.test/proposals/${proposals[0].proposalId}`);
    });

    it("leaves Approve out when approvals on Telegram are off, and tells dry runs nothing", async () => {
      await db.client.userSetting.create({ data: { userId, telegramApprovals: false } });
      const runId = await runner.start(await createVersion(db.client, userId, REPLY), { trigger: "manual" });
      await handlers.advance(runId);
      const buttons = telegram.calls.map((c) => (c.body.reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard[0].map((b) => b.text));
      expect(buttons).toEqual([["Open"], ["Open"]]);

      telegram.calls = [];
      const dry = await runner.start(await createVersion(db.client, userId, REPLY), { trigger: "dry-run", dryRun: true });
      await handlers.advance(dry);
      expect(telegram.calls).toEqual([]);
    });
  });
});

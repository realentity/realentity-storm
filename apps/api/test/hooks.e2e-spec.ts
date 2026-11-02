import { createPrismaConnection, type Prisma, type PrismaConnection } from "@ai-me/db";
import { QUEUES } from "@ai-me/queue";
import { type PipelineDetailView, type WebhookView } from "@ai-me/shared";
import { defaultCatalog, type StepDefinition } from "@ai-me/steps";
import { TestEnvironment } from "@ai-me/testing";
import { createHmac } from "node:crypto";
import request from "supertest";
import { z } from "zod";
import { TELEGRAM_FETCH } from "../src/telegram/telegram-notices";
import { createTestApp, type TestApp } from "./support/test-app";

const TEST_STEPS: StepDefinition[] = [
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
  - id: reply
    type: test.send
    with: { to: "ana@acme.test", body: "Thanks" }
`;

const HOOK = (auth: string) => `
name: Hook ${auth}
trigger: { webhook: ${auth} }
steps:
  - id: tell
    type: notify.telegram
    with: { text: "{{trigger.body}}" }
`;

const ME = 4242;
const SECRET = "s".repeat(40);
const ENV = {
  TELEGRAM_BOT_TOKEN: `123456:${"a".repeat(35)}`,
  TELEGRAM_CHAT_ID: String(ME),
  TELEGRAM_WEBHOOK_SECRET: SECRET,
  APP_ORIGIN: "https://aime.test",
  HOOKS_PUBLIC_URL: "https://hooks.test/aime",
};

interface Call {
  method: string;
  body: Record<string, unknown>;
}

interface Button {
  text: string;
  callback_data?: string;
  url?: string;
}

describe("M12: the AI ME bot and webhooks", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;
  let userId: string;
  let calls: Call[];
  let updates = 0;

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    const fakeFetch: typeof fetch = (input, init) => {
      calls.push({ method: (input as string).split("/").pop()!, body: JSON.parse(init?.body as string) as Record<string, unknown> });
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 100 + calls.length } })));
    };
    api = await createTestApp({ catalog: defaultCatalog().with(...TEST_STEPS), overrides: [{ provide: TELEGRAM_FETCH, useValue: fakeFetch }] });
    agent = await api.signedIn();
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(() => {
    calls = [];
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.userSetting.deleteMany();
    await db.client.$executeRaw`DELETE FROM pgboss.job`;
  });

  afterAll(async () => {
    for (const key of Object.keys(ENV)) delete process.env[key];
    await db.close();
    await api.close();
  });

  const sent = (method = "sendMessage") => calls.filter((c) => c.method === method);
  const buttonsOf = (call: Call): Button[] => (call.body.reply_markup as { inline_keyboard: Button[][] } | undefined)?.inline_keyboard.flat() ?? [];
  const queued = (name: string) =>
    db.client.$queryRaw<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = ${name} AND state = 'created'`;

  function message(text: string, from = ME, chat: { id: number; type: string } = { id: ME, type: "private" }, ageSeconds = 0) {
    return { update_id: ++updates, message: { message_id: updates, from: { id: from }, chat, date: Math.floor(Date.now() / 1000) - ageSeconds, text } };
  }

  function press(data: string, from = ME) {
    return { update_id: ++updates, callback_query: { id: `cb${updates}`, from: { id: from }, message: { message_id: 7, chat: { id: ME, type: "private" } }, data } };
  }

  const telegram = (update: unknown, secret: string | null = SECRET) => {
    const call = request(api.http).post("/api/hooks/telegram");
    return (secret === null ? call : call.set("x-telegram-bot-api-secret-token", secret)).send(update as object);
  };

  async function createPipeline(source: string, enabled = false): Promise<PipelineDetailView> {
    const pipeline = (await agent.post("/api/pipelines").send({ source }).expect(201)).body as PipelineDetailView;
    if (enabled) await agent.patch(`/api/pipelines/${pipeline.pipelineId}`).send({ enabled: true }).expect(200);
    return pipeline;
  }

  /** A run waiting at a gate.act, as the worker leaves it. */
  async function waiting(payload: Record<string, unknown> = { to: "ana@acme.test", body: "Thanks" }, isNew = false): Promise<string> {
    const pipeline = await createPipeline(REPLY);
    const run = await db.client.run.create({
      data: { userId, pipelineVersionId: pipeline.current!.pipelineVersionId, trigger: "manual", status: "WAITING_FOR_USER" },
    });
    const gate = await db.client.step.create({
      data: { runId: run.runId, stepKey: "replyGate", type: "gate.act", status: "WAITING", startedAt: new Date() },
    });
    const proposal = await db.client.proposal.create({
      data: {
        userId,
        runId: run.runId,
        stepId: gate.stepId,
        stepKey: "reply",
        status: "PENDING_REVIEW",
        target: "ana@acme.test",
        targets: [{ field: "to", kind: "recipient", value: "ana@acme.test", basis: isNew ? null : "static", isNew }],
        originalPayload: payload as Prisma.InputJsonValue,
      },
    });
    return proposal.proposalId;
  }

  /** /inbox, and the Approve button of the one proposal it shows. */
  async function approveButton(): Promise<string> {
    await telegram(message("/inbox")).expect(200);
    const approve = buttonsOf(sent().at(-1)!).find((b) => b.text === "Approve");
    if (!approve?.callback_data) throw new Error("no Approve button");
    return approve.callback_data;
  }

  const answer = () => sent("answerCallbackQuery").at(-1)?.body.text;

  describe("M12-S2: only my private chat, with the bot's secret, and fresh commands", () => {
    it("answers a wrong or missing secret like an unknown path, and ignores everyone else", async () => {
      await telegram(message("/help"), "wrong-secret-".repeat(4)).expect(404);
      await telegram(message("/help"), null).expect(404);
      await telegram(message("/help", 999)).expect(200);
      await telegram(message("/help", ME, { id: -100, type: "group" })).expect(200);
      await telegram(message("/help", ME, { id: ME, type: "private" }, 600)).expect(200);
      await telegram(press("r:00000000-0000-4000-8000-000000000001", 999)).expect(200);
      expect(calls).toEqual([]);

      await telegram(message("/help")).expect(200);
      expect(sent()).toHaveLength(1);
      expect(sent()[0].body).toMatchObject({ chat_id: String(ME), text: expect.stringContaining("/run <pipeline>") as unknown });
    });
  });

  describe("M12-I3: commands and buttons", () => {
    it("/run starts a pipeline by name and links the run", async () => {
      const pipeline = await createPipeline(REPLY);
      await telegram(message("/run replies")).expect(200);
      const run = await db.client.run.findFirstOrThrow({ where: { pipelineVersion: { pipelineId: pipeline.pipelineId } } });
      expect(run).toMatchObject({ trigger: "telegram", dryRun: false, status: "QUEUED" });
      expect(await queued(QUEUES.runs)).toEqual([{ data: { runId: run.runId } }]);
      expect(sent()[0].body.text).toBe("Started Replies.");
      expect(buttonsOf(sent()[0])).toEqual([{ text: "Open the run", url: `https://aime.test/runs/${run.runId}` }]);

      await telegram(message("/run nothing")).expect(200);
      expect(sent()[1].body.text).toBe('No pipeline "nothing". Pipelines: Replies');
    });

    it("/inbox shows a proposal; Approve approves it, the run goes on, the message says so", async () => {
      const proposalId = await waiting();
      const data = await approveButton();
      expect(sent()[0].body.text).toContain("Replies: approve test.send?\nTarget: ana@acme.test\n\nto: ana@acme.test\nbody: Thanks");

      await telegram(press(data)).expect(200);
      expect(answer()).toBe("Approved: it acts now");
      const proposal = await db.client.proposal.findUniqueOrThrow({ where: { proposalId }, include: { decision: true } });
      expect(proposal).toMatchObject({ status: "APPROVED", decision: { kind: "APPROVED" } });
      expect(await queued(QUEUES.runs)).toEqual([{ data: { runId: proposal.runId } }]);
      const edit = sent("editMessageText").at(-1)!;
      expect(edit.body).toMatchObject({ message_id: proposal.telegramMessageId, reply_markup: { inline_keyboard: [] } });
      expect(edit.body.text).toMatch(/^✅ Approved in Telegram\n\n/);
    });

    it("Reject rejects; a decision in the app updates the bot's message", async () => {
      const first = await waiting();
      await telegram(message("/inbox")).expect(200);
      await telegram(press(`r:${first}`)).expect(200);
      expect(answer()).toBe("Rejected");
      expect((await db.client.proposal.findUniqueOrThrow({ where: { proposalId: first } })).status).toBe("REJECTED");

      const second = await waiting();
      await telegram(message("/inbox")).expect(200);
      await agent.post(`/api/proposals/${second}/approve`).send({}).expect(200);
      expect(sent("editMessageText").at(-1)!.body.text).toMatch(/^✅ Approved in the app\n\n/);
    });

    it("/pause and /resume turn the kill switch on and off", async () => {
      await telegram(message("/pause")).expect(200);
      expect((await db.client.userSetting.findUniqueOrThrow({ where: { userId } })).paused).toBe(true);
      await telegram(message("/run Replies")).expect(200);
      await telegram(message("/resume")).expect(200);
      expect((await db.client.userSetting.findUniqueOrThrow({ where: { userId } })).paused).toBe(false);
      expect(sent().map((c) => c.body.text)).toEqual([
        "Kill switch on: nothing runs or acts.",
        expect.stringMatching(/^No pipeline "Replies"|^Replies didn't start: /) as unknown,
        "Kill switch off: pipelines run again (stopped runs stay stopped).",
      ]);
    });
  });

  describe("M12-S3: Approve on Telegram only for what the message showed, still pending", () => {
    it("refuses a proposal already decided", async () => {
      const proposalId = await waiting();
      const data = await approveButton();
      await agent.post(`/api/proposals/${proposalId}/reject`).send({}).expect(200);
      await telegram(press(data)).expect(200);
      expect(answer()).toBe("Already rejected");
      expect((await db.client.proposal.findUniqueOrThrow({ where: { proposalId } })).status).toBe("REJECTED");
    });

    it("refuses a payload that changed since the message", async () => {
      const proposalId = await waiting();
      const data = await approveButton();
      await db.client.proposal.update({ where: { proposalId }, data: { originalPayload: { to: "ana@acme.test", body: "Something else" } } });
      await telegram(press(data)).expect(200);
      expect(answer()).toBe("It changed since this message: open it in AI ME");
      expect((await db.client.proposal.findUniqueOrThrow({ where: { proposalId } })).status).toBe("PENDING_REVIEW");
    });

    it("offers no Approve for a payload too long to show, and refuses one pressed anyway", async () => {
      const proposalId = await waiting({ to: "ana@acme.test", body: "x".repeat(5000) });
      await telegram(message("/inbox")).expect(200);
      expect(buttonsOf(sent()[0]).map((b) => b.text)).toEqual(["Reject", "Open"]);
      await telegram(press(`a:${proposalId}:${"0".repeat(16)}`)).expect(200);
      expect(answer()).toBe("Too long to approve here: open it in AI ME");
    });

    it("refuses a new target, and everything with approvals on Telegram off", async () => {
      const proposalId = await waiting(undefined, true);
      const data = await approveButton();
      await telegram(press(data)).expect(200);
      expect(answer()).toBe("New target ana@acme.test: approve it in AI ME");

      await agent.put("/api/settings").send({ telegramApprovals: false }).expect(200);
      await telegram(press(data)).expect(200);
      expect(answer()).toBe("Approvals on Telegram are off (Settings): open it in AI ME");
      await telegram(press(`r:${proposalId}`)).expect(200);
      expect((await db.client.proposal.findUniqueOrThrow({ where: { proposalId } })).status).toBe("PENDING_REVIEW");
    });
  });

  describe("webhooks", () => {
    async function withHook(auth: "token" | "hmac-sha256", enabled = true): Promise<{ pipeline: PipelineDetailView; hook: WebhookView }> {
      const pipeline = await createPipeline(HOOK(auth), enabled);
      const hook = (await agent.put(`/api/pipelines/${pipeline.pipelineId}/webhook`).expect(200)).body as WebhookView;
      return { pipeline, hook };
    }

    const call = (hook: WebhookView) => request(api.http).post(`/api${hook.path}`);

    it("M12-E1 (api): created with its secret shown once, rotated keeping its address, removed", async () => {
      const { pipeline, hook } = await withHook("token");
      expect(hook).toMatchObject({ path: expect.stringMatching(/^\/hooks\/[A-Za-z0-9_-]{43}$/) as unknown, secret: expect.any(String) as unknown, lastCalledAt: null });
      expect(hook.url).toBe(`https://hooks.test/aime/${hook.path.slice("/hooks/".length)}`);
      const read = (await agent.get(`/api/pipelines/${pipeline.pipelineId}/webhook`).expect(200)).body as { webhook: WebhookView };
      expect(read.webhook).not.toHaveProperty("secret");

      const rotated = (await agent.put(`/api/pipelines/${pipeline.pipelineId}/webhook`).expect(200)).body as WebhookView;
      expect(rotated.path).toBe(hook.path);
      expect(rotated.secret).not.toBe(hook.secret);
      await call(hook).set("authorization", `Bearer ${hook.secret}`).send({}).expect(401);
      await call(hook).set("authorization", `Bearer ${rotated.secret}`).send({}).expect(202);

      await agent.delete(`/api/pipelines/${pipeline.pipelineId}/webhook`).expect(204);
      expect(((await agent.get(`/api/pipelines/${pipeline.pipelineId}/webhook`).expect(200)).body as { webhook: null }).webhook).toBeNull();
      await call(hook).set("authorization", `Bearer ${rotated.secret}`).send({}).expect(404);
    });

    it("M12-S1: a token webhook takes only its bearer token; nothing is queued otherwise", async () => {
      const { hook } = await withHook("token");
      await call(hook).send({ ref: "x" }).expect(401);
      await call(hook).set("authorization", "Bearer wrong").send({ ref: "x" }).expect(401);
      await request(api.http).post(`/api/hooks/${"A".repeat(43)}`).set("authorization", `Bearer ${hook.secret}`).send({}).expect(404);
      await request(api.http).post("/api/hooks/not-a-hook").send({}).expect(404);
      await call(hook)
        .set("authorization", `Bearer ${hook.secret}`)
        .send({ text: "x".repeat(70 * 1024) })
        .expect(413);
      expect(await queued(QUEUES.webhooks)).toEqual([]);

      await call(hook).set("authorization", `Bearer ${hook.secret}`).set("x-github-event", "push").send({ ref: "x" }).expect(202);
      const [job] = await queued(QUEUES.webhooks);
      expect(job.data).toMatchObject({ webhookId: hook.path.slice(7), signature: null, event: "push" });
      expect(Buffer.from(job.data.body as string, "base64").toString()).toBe('{"ref":"x"}');
    });

    it("M12-S1: a disabled pipeline, or one whose trigger isn't a webhook, has no webhook", async () => {
      const { hook } = await withHook("token", false);
      await call(hook).set("authorization", `Bearer ${hook.secret}`).send({}).expect(404);
      const manual = await createPipeline(REPLY, true);
      const other = (await agent.put(`/api/pipelines/${manual.pipelineId}/webhook`).expect(200)).body as WebhookView;
      await call(other).set("authorization", `Bearer ${other.secret}`).send({}).expect(404);
    });

    it("an hmac-sha256 webhook needs a signature header; the worker checks it against the bytes as sent", async () => {
      const { hook } = await withHook("hmac-sha256");
      const body = '{ "ref" : "refs/heads/main" }';
      await call(hook).set("content-type", "application/json").send(body).expect(401);
      const signature = `sha256=${createHmac("sha256", hook.secret!).update(body).digest("hex")}`;
      await call(hook).set("content-type", "application/json").set("x-hub-signature-256", signature).send(body).expect(202);
      const [job] = await queued(QUEUES.webhooks);
      expect(job.data).toMatchObject({ signature });
      expect(Buffer.from(job.data.body as string, "base64").toString()).toBe(body);
    });
  });
  // M15: facts on the Profile page; a run's question answered on its page or by a Telegram reply.
  describe("M15: facts and questions", () => {
    afterEach(async () => {
      await db.client.fact.deleteMany();
    });

    /** A run waiting for my answer, as the worker's Asker leaves it: the question (asked on Telegram) and the wait. */
    async function asked(options: string[] = [], telegramMessageId = 777) {
      const pipeline = await createPipeline(REPLY);
      const run = await db.client.run.create({
        data: { userId, pipelineVersionId: pipeline.current!.pipelineVersionId, trigger: "manual", status: "WAITING_FOR_USER" },
      });
      const question = await db.client.question.create({
        data: { userId, runId: run.runId, stepKey: "map", question: "Salary expectation", options, site: "ats.test", telegramMessageId },
      });
      const wait = await db.client.takeover.create({ data: { runId: run.runId, stepKey: "map", status: "OPEN", reason: "A question for you", waitsFor: "answer" } });
      return { run, question, wait };
    }
    const reply = (text: string, to: number) => ({ ...message(text), message: { ...message(text).message, reply_to_message: { message_id: to } } });

    it("a reply on Telegram answers the question: a fact, the run goes on, and the bot says so", async () => {
      const { run, question, wait } = await asked();
      await telegram(reply("4 000 EUR net", 777)).expect(200);

      expect(await db.client.question.findUniqueOrThrow({ where: { questionId: question.questionId } })).toMatchObject({ status: "ANSWERED", answer: "4 000 EUR net" });
      const fact = await db.client.fact.findFirstOrThrow({ where: { userId } });
      expect(fact).toMatchObject({ question: "Salary expectation", answer: "4 000 EUR net", source: "ASKED", site: "ats.test", runId: run.runId });
      expect(await db.client.question.findUniqueOrThrow({ where: { questionId: question.questionId } })).toMatchObject({ factId: fact.factId });
      expect(await db.client.takeover.findUniqueOrThrow({ where: { takeoverId: wait.takeoverId } })).toMatchObject({ status: "CONTINUED" });
      expect(sent().at(-1)?.body.text).toBe('Thanks: "Salary expectation" is 4 000 EUR net. Kept for the next forms; the run goes on.');

      // Again: already answered, said so; a reply to another message is no answer (the help).
      await telegram(reply("5 000", 777)).expect(200);
      expect(sent().at(-1)?.body.text).toBe("Not taken: Already answered");
      await telegram(reply("hello", 12345)).expect(200);
      expect(sent().at(-1)?.body.text).toContain("/run <pipeline>");
      // Only my chat answers.
      const other = await asked([], 778);
      await telegram({ ...reply("1 EUR", 778), message: { ...reply("1 EUR", 778).message, from: { id: 1 }, chat: { id: 1, type: "private" } } }).expect(200);
      expect(await db.client.question.findUniqueOrThrow({ where: { questionId: other.question.questionId } })).toMatchObject({ status: "OPEN" });
    });

    it("answered on the run page: shown there while open; a choice must be one of its options", async () => {
      const { run, question } = await asked(["Immediately", "1 month", "3 months"]);
      const detail = (await agent.get(`/api/runs/${run.runId}`).expect(200)).body as { question: { questionId: string; options: string[] } | null };
      expect(detail.question).toMatchObject({ questionId: question.questionId, options: ["Immediately", "1 month", "3 months"] });

      await agent.post(`/api/questions/${question.questionId}/answer`).send({ answer: "two weeks" }).expect(400);
      const answered = await agent.post(`/api/questions/${question.questionId}/answer`).send({ answer: "1 MONTH" }).expect(200);
      expect(answered.body).toMatchObject({ status: "ANSWERED", answer: "1 month" });
      await agent.post(`/api/questions/${question.questionId}/answer`).send({ answer: "1 month" }).expect(409);
      expect(((await agent.get(`/api/runs/${run.runId}`).expect(200)).body as { question: unknown }).question).toBeNull();
    });

    it("facts on the Profile page: added, edited, one per question, deleted", async () => {
      const created = (await agent.post("/api/facts").send({ question: "Willing to relocate?", answer: "No" }).expect(201)).body as { factId: string };
      await agent.post("/api/facts").send({ question: "willing to relocate", answer: "Yes" }).expect(409);
      const edited = await agent.put(`/api/facts/${created.factId}`).send({ question: "Willing to relocate?", answer: "Within the EU" }).expect(200);
      expect(edited.body).toMatchObject({ answer: "Within the EU", source: "ME" });
      expect(((await agent.get("/api/facts").expect(200)).body as unknown[]).length).toBe(1);
      await agent.delete(`/api/facts/${created.factId}`).expect(204);
      expect((await agent.get("/api/facts").expect(200)).body).toEqual([]);
    });
  });
});

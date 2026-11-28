import { payloadHash } from "@realentity/storm-crypto";
import { createPrismaConnection, type Prisma, type PrismaConnection, type Proposal } from "@realentity/storm-db";
import { entityItem, readAppSource } from "@realentity/storm-shared";
import { exampleYaml } from "@realentity/storm-shared/example-files";
import { defaultCatalog, PipelineCompiler } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { SaveStep } from "../src/steps/data-steps";
import { ReadStep } from "../src/steps/entity-steps";
import { MapStep } from "../src/steps/map-alert-steps";
import { Counting, createVersion } from "./support/test-steps";

jest.setTimeout(60_000);

/** One of my sent emails nobody answered, as email.awaiting lists it. */
const thread = (n: number, to: string, followUps = 0) => {
  const messageId = `<sent-${n}@mail.example>`;
  return {
    threadId: `<thread-${n}@mail.example>`,
    to,
    subject: `Proposal ${n}`,
    sentAt: "2026-11-10T09:00:00.000Z",
    daysWaiting: 11,
    followUps,
    message: {
      uid: n,
      messageId,
      threadId: `<thread-${n}@mail.example>`,
      inReplyTo: null,
      references: [],
      from: "me@mail.example",
      fromName: null,
      replyTo: "me@mail.example",
      to: [to],
      cc: [],
      subject: `Proposal ${n}`,
      date: "2026-11-10T09:00:00.000Z",
      text: "Here is the proposal we talked about.",
      attachments: [],
      account: null,
    },
    references: [messageId],
  };
};

// M58-T3: the Follow-ups App: unanswered emails listed, a nudge each approved as one batch, Snooze and Drop
describe("examples/apps/follow-ups.yaml", () => {
  const compiler = new PipelineCompiler(defaultCatalog());
  const appSource = exampleYaml("apps/follow-ups.yaml");
  const definition = readAppSource(appSource);
  let db: PrismaConnection;
  let userId: string;
  let appId: string;
  let awaiting: Counting;
  let draft: Counting;
  let send: Counting;
  let later: Counting;
  let runner: PipelineRunner;
  let threads: ReturnType<typeof thread>[];

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(async () => {
    const app = await db.client.app.create({ data: { userId, name: "Follow-ups" } });
    const version = await db.client.appVersion.create({ data: { appId: app.appId, version: 1, definition: {}, source: appSource } });
    await db.client.app.update({ where: { appId: app.appId }, data: { currentVersionId: version.appVersionId } });
    appId = app.appId;
    threads = [thread(1, "ana@client.example"), thread(2, "bo@client.example"), thread(3, "cy@client.example")];
    awaiting = new Counting("email.awaiting", () => ({ threads }));
    draft = new Counting("email.draftFollowUp", (input) => ({
      subject: `Re: ${(input.message as { subject: string }).subject}`,
      body: "Did you have a chance to look at it?",
      language: "en",
      drewOn: [],
    }));
    send = new Counting("email.send", (input) => ({ messageId: `<nudge-${send.calls.length}@mail.example>`, accepted: [input.to], from: "me@mail.example" }));
    later = new Counting("flow.later", () => ({ scheduledStartId: "s-1", fireAt: "2026-12-07T09:00:00.000Z", replaced: 0 }));
    runner = new PipelineRunner(
      db.client,
      defaultCatalog(),
      new ExecutorRegistry([new ReadStep(db.client), new SaveStep(db.client), new MapStep(), awaiting, draft, send, later]),
    );
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.app.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  const version = (name: string) => createVersion(db.client, userId, exampleYaml(`${name}.yaml`), compiler, { app: definition });
  const rows = async () =>
    Object.fromEntries(
      (await db.client.dataEntity.findMany({ where: { appId, type: "FollowUp" }, orderBy: { key: "asc" } })).map((r) => [r.key, r.stage]),
    );
  const finish = async (runId: string) => {
    const status = await runner.advance(runId);
    if (status === "FAILED") {
      const failed = await db.client.step.findMany({ where: { runId, error: { not: null } }, select: { stepKey: true, error: true } });
      const run = await db.client.run.findUniqueOrThrow({ where: { runId } });
      throw new Error([run.summary, ...failed.map((f) => `${f.stepKey}: ${f.error}`)].join("\n"));
    }
    expect(status).toBe("DONE");
  };
  /** The batch at the gate, decided as the inbox does: the ones ticked approved, the rest rejected. */
  const decide = async (runId: string, approve: (p: Proposal) => boolean) => {
    const batch = await db.client.proposal.findMany({ where: { runId }, orderBy: [{ itemIndex: "asc" }] });
    for (const p of batch) {
      const payload = p.originalPayload as Prisma.InputJsonValue;
      const status = approve(p) ? "APPROVED" : "REJECTED";
      await db.client.proposal.update({ where: { proposalId: p.proposalId }, data: { status, finalPayload: payload, payloadHash: payloadHash(payload) } });
    }
    return batch;
  };
  const weekly = async () => {
    const runId = await runner.start(await version("follow-ups"), { trigger: "schedule", triggerData: {} });
    expect(await runner.advance(runId)).toBe("WAITING_FOR_USER");
    return runId;
  };

  it("lists the unanswered emails, a nudge each in one batch; the approved ones sent in their thread, the unticked one snoozed", async () => {
    const runId = await weekly();
    expect(awaiting.calls[0]).toMatchObject({ maxFollowUps: 2 });
    expect(await rows()).toEqual({ "<thread-1@mail.example>": "waiting", "<thread-2@mail.example>": "waiting", "<thread-3@mail.example>": "waiting" });
    expect(send.calls).toEqual([]);

    const batch = await decide(runId, (p) => (p.originalPayload as { to: string }).to !== "bo@client.example");
    expect(batch).toHaveLength(3);
    expect(batch[0].originalPayload).toMatchObject({ to: "ana@client.example", subject: "Re: Proposal 1", inReplyTo: "<sent-1@mail.example>" });
    await finish(runId);

    expect(send.calls.map((c) => c.to)).toEqual(["ana@client.example", "cy@client.example"]);
    expect(await rows()).toEqual({ "<thread-1@mail.example>": "nudged", "<thread-2@mail.example>": "snoozed", "<thread-3@mail.example>": "nudged" });
    const ana = await db.client.dataEntity.findUniqueOrThrow({ where: { appId_type_key: { appId, type: "FollowUp", key: "<thread-1@mail.example>" } } });
    expect(entityItem(ana.value, ana.mine)).toMatchObject({ to: "ana@client.example", followUps: 1 });
  });

  it("a snoozed or dropped thread gets no nudge; a nudged one still unanswered gets its second", async () => {
    const save = (key: string, stage: string) =>
      db.client.dataEntity.create({ data: { appId, type: "FollowUp", key, value: { threadId: key, subject: "x" }, stage } });
    await save("<thread-1@mail.example>", "snoozed");
    await save("<thread-2@mail.example>", "dropped");
    await save("<thread-3@mail.example>", "nudged");
    threads[2] = thread(3, "cy@client.example", 1);

    const runId = await weekly();
    expect(draft.calls).toHaveLength(1);
    await decide(runId, () => true);
    await finish(runId);
    expect(send.calls.map((c) => c.to)).toEqual(["cy@client.example"]);
    expect(await rows()).toEqual({ "<thread-1@mail.example>": "snoozed", "<thread-2@mail.example>": "dropped", "<thread-3@mail.example>": "nudged" });
  });

  it("nothing waiting: no gate, nothing sent", async () => {
    threads = [];
    const runId = await runner.start(await version("follow-ups"), { trigger: "schedule", triggerData: {} });
    await finish(runId);
    expect(send.calls).toEqual([]);
    expect(await rows()).toEqual({});
  });

  it("Snooze: it waits again in two weeks, unless you moved it in the meantime", async () => {
    const key = "<thread-1@mail.example>";
    await db.client.dataEntity.create({ data: { appId, type: "FollowUp", key, value: { threadId: key, subject: "Proposal 1" }, stage: "snoozed" } });
    const snooze = await runner.start(await version("snooze"), {
      trigger: "event",
      triggerData: { app: "Follow-ups", appId, type: "FollowUp", key, item: { threadId: key }, stage: { from: "waiting", to: "snoozed" }, by: "me" },
    });
    await finish(snooze);
    expect(later.calls).toHaveLength(1);
    expect(later.calls[0]).toMatchObject({ after: "14d", key: `snooze:${key}`, data: { threadId: key } });

    const wake = await version("wake");
    await finish(await runner.start(wake, { trigger: "event", triggerData: { data: { threadId: key } } }));
    expect(await rows()).toEqual({ [key]: "waiting" });

    await db.client.dataEntity.update({ where: { appId_type_key: { appId, type: "FollowUp", key } }, data: { stage: "dropped" } });
    await finish(await runner.start(wake, { trigger: "event", triggerData: { data: { threadId: key } } }));
    expect(await rows()).toEqual({ [key]: "dropped" });
  });
});

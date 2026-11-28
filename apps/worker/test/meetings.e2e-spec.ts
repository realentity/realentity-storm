import { payloadHash } from "@realentity/storm-crypto";
import { createPrismaConnection, type Prisma, type PrismaConnection } from "@realentity/storm-db";
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

const THREAD = "<ask-1@client.example>";

/** An email as email.fetch reads it. */
const email = (id: string, from: string, subject: string, text: string, thread = id) => ({
  uid: 1,
  messageId: id,
  threadId: thread,
  inReplyTo: thread === id ? null : thread,
  references: thread === id ? [] : [thread],
  from,
  fromName: from === "ana@client.example" ? "Ana" : null,
  replyTo: from,
  to: ["me@mail.example"],
  cc: [],
  subject,
  date: "2026-11-21T08:00:00.000Z",
  text,
  attachments: [],
  account: null,
});

// M58-T4: the Meetings App: a request answered with free times, the chosen one booked, one nudge; each approved first
describe("examples/apps/meetings.yaml", () => {
  const compiler = new PipelineCompiler(defaultCatalog());
  const appSource = exampleYaml("apps/meetings.yaml");
  const definition = readAppSource(appSource);
  let db: PrismaConnection;
  let userId: string;
  let appId: string;
  let inbox: ReturnType<typeof email>[];
  let chosen: string;
  let steps: Record<string, Counting>;
  let runner: PipelineRunner;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(async () => {
    const app = await db.client.app.create({ data: { userId, name: "Meetings" } });
    const version = await db.client.appVersion.create({ data: { appId: app.appId, version: 1, definition: {}, source: appSource } });
    await db.client.app.update({ where: { appId: app.appId }, data: { currentVersionId: version.appVersionId } });
    appId = app.appId;
    inbox = [];
    chosen = "2026-11-25T10:00:00+01:00";
    type Message = ReturnType<typeof email>;
    steps = {
      fetch: new Counting("email.fetch", () => ({ messages: inbox })),
      classify: new Counting("email.classify", (input) => {
        const messages = input.messages as Message[];
        const meeting = (m: Message) => /meet|call/i.test(m.subject);
        return {
          kept: messages.filter(meeting),
          dropped: messages.filter((m) => !meeting(m)),
          results: messages.map((m, index) => ({ index, label: meeting(m) ? "meeting" : "skip", reason: "" })),
        };
      }),
      find: new Counting("calendar.find", () => ({
        events: [{ id: "e1", title: "Dentist", start: "2026-11-24T10:00:00+01:00", end: "2026-11-24T11:00:00+01:00", allDay: false }],
        count: 1,
        none: false,
      })),
      reply: new Counting("email.draftReply", () => ({ subject: "Re: Can we meet?", body: "Tuesday 10:00, Wednesday 10:00 or Thursday 14:00?", language: "en", drewOn: [] })),
      send: new Counting("email.send", (input) => ({ messageId: `<sent-${steps.send.calls.length}@mail.example>`, accepted: [input.to], from: "me@mail.example" })),
      extract: new Counting("llm.extract", () => ({ values: { start: chosen }, missing: chosen ? [] : ["start"], found: !!chosen })),
      create: new Counting("calendar.create", (input) => ({
        created: true,
        eventId: "ev-1",
        link: "https://calendar.example/ev-1",
        meetLink: "https://meet.example/abc",
        invited: input.attendees as string[],
      })),
      telegram: new Counting("notify.telegram", () => ({ sent: true })),
      awaiting: new Counting("email.awaiting", () => ({ threads: [] })),
      nudge: new Counting("email.draftFollowUp", () => ({ subject: "Re: Can we meet?", body: "Did one of the times suit you?", language: "en", drewOn: [] })),
    };
    runner = new PipelineRunner(db.client, defaultCatalog(), new ExecutorRegistry([new ReadStep(db.client), new SaveStep(db.client), new MapStep(), ...Object.values(steps)]));
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.app.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  const meeting = async () => {
    const row = await db.client.dataEntity.findUnique({ where: { appId_type_key: { appId, type: "Meeting", key: THREAD } } });
    return row && { item: entityItem(row.value, row.mine), stage: row.stage };
  };
  const proposedOne = () =>
    db.client.dataEntity.create({
      data: { appId, type: "Meeting", key: THREAD, value: { threadId: THREAD, subject: "Can we meet?", name: "Ana", email: "ana@client.example", proposedAt: "2026-11-18T09:00:00.000Z" }, stage: "proposed" },
    });
  const finish = async (runId: string) => {
    const status = await runner.advance(runId);
    if (status === "FAILED") {
      const failed = await db.client.step.findMany({ where: { runId, error: { not: null } }, select: { stepKey: true, error: true } });
      const run = await db.client.run.findUniqueOrThrow({ where: { runId } });
      throw new Error([run.summary, ...failed.map((f) => `${f.stepKey}: ${f.error}`)].join("\n"));
    }
    expect(status).toBe("DONE");
  };
  const approveAll = async (runId: string) => {
    const batch = await db.client.proposal.findMany({ where: { runId }, orderBy: [{ itemIndex: "asc" }] });
    for (const p of batch) {
      const payload = p.originalPayload as Prisma.InputJsonValue;
      await db.client.proposal.update({ where: { proposalId: p.proposalId }, data: { status: "APPROVED", finalPayload: payload, payloadHash: payloadHash(payload) } });
    }
    return batch;
  };
  const start = async (name: string) =>
    runner.start(await createVersion(db.client, userId, exampleYaml(`${name}.yaml`), compiler, { app: definition }), { trigger: "schedule", triggerData: {} });

  it("a request: a reply with times your calendar has free, sent once approved; the Meeting is proposed", async () => {
    inbox = [email(THREAD, "ana@client.example", "Can we meet next week?", "Could we have a call about the project?"), email("<news@shop.example>", "news@shop.example", "Black Friday", "Sale")];
    const runId = await start("meetings");
    expect(await runner.advance(runId)).toBe("WAITING_FOR_USER");
    expect(steps.reply.calls[0]).toMatchObject({ context: "My calendar in the next 7 days is busy at: 2026-11-24T10:00:00+01:00 to 2026-11-24T11:00:00+01:00." });
    expect(steps.send.calls).toEqual([]);
    expect(await meeting()).toBeNull();

    const [gate] = await approveAll(runId);
    expect(gate.originalPayload).toMatchObject({ to: "ana@client.example", inReplyTo: THREAD });
    await finish(runId);
    expect(steps.send.calls.map((c) => c.to)).toEqual(["ana@client.example"]);
    expect(await meeting()).toMatchObject({ stage: "proposed", item: { name: "Ana", email: "ana@client.example", subject: "Can we meet next week?" } });
  });

  it("nothing asking to meet: the calendar isn't read", async () => {
    inbox = [email("<news@shop.example>", "news@shop.example", "Black Friday", "Sale")];
    await finish(await start("meetings"));
    expect(steps.find.calls).toEqual([]);
    expect(steps.send.calls).toEqual([]);
  });

  it("their answer with a time: an event with them invited, created once approved; the Meeting is booked", async () => {
    await proposedOne();
    inbox = [email("<re-1@client.example>", "ana@client.example", "Re: Can we meet?", "Wednesday at 10 works for me.", THREAD)];
    const runId = await start("meetings");
    expect(await runner.advance(runId)).toBe("WAITING_FOR_USER");
    expect(steps.classify.calls[0]).toMatchObject({ messages: [] });
    const [gate] = await approveAll(runId);
    expect(gate.originalPayload).toMatchObject({ title: "Ana: Can we meet?", start: chosen, attendees: ["ana@client.example"], meet: true, durationMinutes: 30 });
    await finish(runId);
    expect(steps.create.calls).toHaveLength(1);
    expect(await meeting()).toMatchObject({
      stage: "booked",
      item: { start: "2026-11-25T09:00:00.000Z", link: "https://calendar.example/ev-1", proposedAt: "2026-11-18T09:00:00.000Z", email: "ana@client.example" },
    });
  });

  it("their answer without a time: you're told, nothing created, still proposed", async () => {
    await proposedOne();
    chosen = "";
    inbox = [email("<re-1@client.example>", "ana@client.example", "Re: Can we meet?", "Next month would be better.", THREAD)];
    await finish(await start("meetings"));
    expect(steps.create.calls).toEqual([]);
    expect(steps.telegram.calls.map((c) => c.text)).toEqual(['ana@client.example answered about "Re: Can we meet?" without choosing a time: see your inbox.']);
    expect((await meeting())?.stage).toBe("proposed");
  });

  it("no answer in 3 days: one nudge for a proposed Meeting, none for other threads; approved, it is noted", async () => {
    await proposedOne();
    const thread = (threadId: string, to: string) => {
      const message = email(`<mine-${to}>`, "me@mail.example", "Re: Can we meet?", "Tuesday 10:00?", threadId);
      return { threadId, to, subject: message.subject, sentAt: message.date, daysWaiting: 3, followUps: 0, message, references: [threadId, message.messageId] };
    };
    steps.awaiting = new Counting("email.awaiting", () => ({ threads: [thread(THREAD, "ana@client.example"), thread("<other@x.example>", "bo@x.example")] }));
    runner = new PipelineRunner(db.client, defaultCatalog(), new ExecutorRegistry([new ReadStep(db.client), new SaveStep(db.client), new MapStep(), ...Object.values(steps)]));
    const runId = await start("meeting-nudge");
    expect(await runner.advance(runId)).toBe("WAITING_FOR_USER");
    expect(steps.awaiting.calls[0]).toMatchObject({ afterDays: 3, maxFollowUps: 1 });
    expect(steps.nudge.calls).toHaveLength(1);
    await approveAll(runId);
    await finish(runId);
    expect(steps.send.calls.map((c) => c.to)).toEqual(["ana@client.example"]);
    expect(await meeting()).toMatchObject({ stage: "proposed", item: { proposedAt: "2026-11-18T09:00:00.000Z", nudgedAt: expect.any(String) as string } });
  });
});

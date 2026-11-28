import { exampleYaml } from "@realentity/storm-shared/example-files";
import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { defaultCatalog, PipelineCompiler, type EmailMessage } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { DedupeStep, SaveStep } from "../src/steps/data-steps";
import { MapStep } from "../src/steps/map-alert-steps";
import { Counting, createVersion } from "./support/test-steps";

jest.setTimeout(60_000);

/** One of the user's sent emails waiting `days` for an answer, as email.awaiting lists it. */
const thread = (n: number, days: number) => {
  const message: EmailMessage = {
    uid: n,
    messageId: `<m${n}@storm.test>`,
    threadId: `<m${n}@storm.test>`,
    inReplyTo: null,
    references: [],
    from: "me@storm.test",
    fromName: null,
    replyTo: "me@storm.test",
    to: [`p${n}@client.example`],
    cc: [],
    subject: `Proposal ${n}`,
    date: new Date(Date.now() - days * 86_400_000).toISOString(),
    text: "The whole email, which the list doesn't keep.",
    attachments: [],
  };
  return { threadId: message.threadId, to: message.to[0], subject: message.subject, sentAt: message.date, daysWaiting: days, followUps: 0, message, references: [message.messageId] };
};

// M22, M71-T5: email.awaiting remembers nothing; the pipeline's own list keeps what it proposed
describe("examples/pipelines/email-follow-ups.yaml", () => {
  const catalog = defaultCatalog();
  let db: PrismaConnection;
  let userId: string;
  let waiting: ReturnType<typeof thread>[];
  let draft: Counting;
  let runner: PipelineRunner;
  let versionId: string;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(async () => {
    waiting = [];
    draft = new Counting("email.draftFollowUp", () => ({ subject: "Re: Proposal", body: "Any thoughts?", language: "en", drewOn: [] }));
    runner = new PipelineRunner(
      db.client,
      catalog,
      new ExecutorRegistry([
        new Counting("email.awaiting", () => ({ threads: waiting })),
        new DedupeStep(db.client),
        new MapStep(),
        new SaveStep(db.client),
        draft,
        new Counting("email.send", () => ({ sent: true, messageId: "<sent@storm.test>" })),
      ]),
    );
    versionId = await createVersion(db.client, userId, exampleYaml("email-follow-ups.yaml"), new PipelineCompiler(catalog));
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.dataRecord.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  /** A run up to its gate (the sends wait for approval): the emails it drafted a nudge for. */
  const run = async (dryRun = false): Promise<string[]> => {
    const before = draft.calls.length;
    const runId = await runner.start(versionId, { trigger: "manual", dryRun });
    const status = await runner.advance(runId);
    if (status === "FAILED") throw new Error(JSON.stringify(await db.client.step.findMany({ where: { runId, error: { not: null } }, select: { stepKey: true, error: true } })));
    return draft.calls.slice(before).map((c) => (c.message as EmailMessage).messageId);
  };

  it("proposes each email once, the five waiting longest first; a dry run keeps nothing; the list keeps no email's text", async () => {
    waiting = [1, 2, 3, 4, 5, 6, 7].map((n) => thread(n, 20 - n));
    expect(await run(true)).toEqual(["<m1@storm.test>", "<m2@storm.test>", "<m3@storm.test>", "<m4@storm.test>", "<m5@storm.test>"]);
    expect(await db.client.dataRecord.count()).toBe(0);

    expect(await run()).toHaveLength(5);
    const kept = await db.client.dataRecord.findMany({ where: { userId, collection: "follow-ups" }, orderBy: { key: "asc" } });
    expect(kept.map((r) => r.key)).toEqual(["<m1@storm.test>", "<m2@storm.test>", "<m3@storm.test>", "<m4@storm.test>", "<m5@storm.test>"]);
    expect(kept[0].value).toEqual({ message: { messageId: "<m1@storm.test>" }, threadId: "<m1@storm.test>", to: "p1@client.example", subject: "Proposal 1" });

    // Proposed before, approved or not: only the rest, then nothing.
    expect(await run()).toEqual(["<m6@storm.test>", "<m7@storm.test>"]);
    expect(await run()).toEqual([]);
  });
});

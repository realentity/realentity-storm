import { createPrismaConnection, llmSpendSince, type PrismaConnection } from "@realentity/storm-db";
import { ModelRouter, type BatchItemResult, type BatchRequest, type LlmBatches, type LlmUsage } from "@realentity/storm-llm";
import { type EmailMessage, type TopicProposal } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { type z } from "zod";
import { type MailConnector } from "../src/mail/mail-connector";
import { TopicBackfills } from "../src/sources/backfill";

const usage = (costUsd: number): LlmUsage => ({
  models: ["claude-haiku-5-5"],
  calls: 1,
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd,
});

/** A Batch API that answers at once: `answer` per request's prompt. */
class FakeBatches implements LlmBatches {
  batches = new Map<string, BatchRequest<z.ZodObject>[]>();
  constructor(private readonly answer: (system: string, prompt: string) => unknown) {}
  submit<S extends z.ZodObject>(requests: BatchRequest<S>[]): Promise<string> {
    const id = `batch-${this.batches.size + 1}`;
    this.batches.set(id, requests);
    return Promise.resolve(id);
  }
  ended(): Promise<boolean> {
    return Promise.resolve(true);
  }
  results<S extends z.ZodObject>(batchId: string, schema: S): Promise<BatchItemResult<z.infer<S>>[]> {
    return Promise.resolve(
      this.batches.get(batchId)!.map((r) => ({
        customId: r.customId,
        ok: true as const,
        output: schema.parse(this.answer(r.request.system, r.request.prompt)),
        usage: usage(0.001),
      })),
    );
  }
}

let n = 0;
const email = (extra: Partial<EmailMessage>): EmailMessage => {
  const id = `<h${++n}@client.example>`;
  return {
    uid: n,
    messageId: id,
    threadId: id,
    inReplyTo: null,
    references: [],
    from: "maria@client.example",
    fromName: "Maria",
    replyTo: "maria@client.example",
    to: ["me@storm.test"],
    cc: [],
    subject: "Orion",
    date: "2026-10-01T09:00:00.000Z",
    text: "Hi.",
    attachments: [],
    ...extra,
  };
};

// M43-T5: a topic's history read for facts, after an estimate, through the Batch API
describe("a topic's backfill", () => {
  let db: PrismaConnection;
  let userId: string;
  let orion: string;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(async () => {
    orion = (
      await db.client.topic.create({
        data: {
          userId,
          name: "Orion",
          description: "The portal rebuild",
          directions: { create: [{ kind: "DOMAIN", value: "client.example" }] },
        },
      })
    ).topicId;
  });

  afterEach(async () => {
    await db.client.topic.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  it("an estimate from its exact directions and threads; the batches only once started; the proposals wait", async () => {
    const decision = email({ subject: "Launch", text: "We launch in March.", date: "2026-10-02T09:00:00.000Z" });
    // A private address in the same thread belongs too; an unrelated email doesn't.
    const reply = email({
      from: "maria@home.test",
      subject: "Re: Launch",
      threadId: decision.messageId,
      text: "Thanks!",
      date: "2026-10-03T09:00:00.000Z",
    });
    const unrelated = email({ from: "news@shop.test", subject: "Sale", text: "50% off" });
    const mine = email({
      from: "me@storm.test",
      fromName: null,
      to: ["ivan@client.example"],
      subject: "Database",
      text: "We go with PostgreSQL.",
      date: "2026-10-04T09:00:00.000Z",
    });
    const asked: string[][] = [];
    const mail: MailConnector = {
      fetch: () => Promise.reject(new Error("unused")),
      send: () => Promise.reject(new Error("unused")),
      attachments: () => Promise.reject(new Error("unused")),
      recent: (_user, request) => Promise.resolve(request.mailbox === "INBOX" ? [decision, reply, unrelated] : [mine]),
      thread: (_user, ids) => {
        asked.push(ids);
        return Promise.resolve(
          [decision, reply, mine].filter((m) => ids.includes(m.messageId)).map((message) => ({ message, mine: message === mine })),
        );
      },
    };
    // An indexed document of its source counts too, read from the index.
    const source = await db.client.topicSource.create({
      data: { userId, topicId: orion, kind: "GITHUB", location: "acme/orion", path: "docs/**", cursor: "c0ffee1" },
    });
    await db.client.topicPassage.create({
      data: {
        userId,
        topicId: orion,
        topicSourceId: source.topicSourceId,
        path: "docs/hosting.md",
        ref: "c0ffee1abc",
        refDate: new Date("2026-09-01"),
        heading: "Hosting",
        ordinal: 0,
        text: "The client's cloud.",
      },
    });

    const batches = new FakeBatches((system, prompt) => {
      if (system.startsWith("You screen")) return { results: [{ index: 0, worth: !prompt.includes("Thanks!") }] };
      if (prompt.includes("We launch in March"))
        return {
          proposals: [
            { topic: "Orion", kind: "new", about: "Launch date", statement: "March", replaces: null, quote: "We launch in March." },
          ],
        };
      if (prompt.includes("PostgreSQL"))
        return {
          proposals: [
            { topic: "Orion", kind: "new", about: "Database", statement: "PostgreSQL", replaces: null, quote: "We go with PostgreSQL." },
          ],
        };
      return { proposals: [] };
    });
    const later: string[] = [];
    const backfills = new TopicBackfills(
      db.client,
      mail,
      batches,
      new ModelRouter(() => Promise.resolve(null)),
      { overBudget: () => Promise.resolve(false) },
      (id) => {
        later.push(id);
        return Promise.resolve();
      },
    );

    const { topicBackfillId } = await db.client.topicBackfill.create({ data: { userId, topicId: orion, months: 3, documents: true } });
    const now = new Date("2026-11-10T12:00:00Z");
    await backfills.step(topicBackfillId, now);
    let backfill = await db.client.topicBackfill.findUniqueOrThrow({ where: { topicBackfillId } });
    expect(backfill.status).toBe("ESTIMATED");
    expect((backfill.emails as { messageId: string }[]).map((e) => e.messageId)).toEqual([
      decision.messageId,
      reply.messageId,
      mine.messageId,
    ]);
    expect(backfill.files).toEqual([{ topicSourceId: source.topicSourceId, path: "docs/hosting.md" }]);
    expect(backfill.estimateUsd).toBeGreaterThan(0);
    // Nothing read by an LLM before the user starts it.
    expect(batches.batches.size).toBe(0);
    await backfills.step(topicBackfillId, now);
    expect(batches.batches.size).toBe(0);

    await db.client.topicBackfill.update({ where: { topicBackfillId }, data: { status: "SCREENING" } });
    await backfills.step(topicBackfillId, now); // the screen submitted
    expect(batches.batches.get("batch-1")).toHaveLength(4);
    await backfills.step(topicBackfillId, now); // read: three worth it
    backfill = await db.client.topicBackfill.findUniqueOrThrow({ where: { topicBackfillId } });
    expect(backfill).toMatchObject({ status: "PROPOSING", worth: [0, 2, 3], batchId: null });
    await backfills.step(topicBackfillId, now); // the writing model's batch submitted
    expect(batches.batches.get("batch-2")?.map((r) => r.customId)).toEqual(["0", "2", "3"]);
    await backfills.step(topicBackfillId, now); // its proposals
    backfill = await db.client.topicBackfill.findUniqueOrThrow({ where: { topicBackfillId } });
    expect(backfill.status).toBe("REVIEW");
    expect((backfill.proposals as unknown as TopicProposal[]).map((p) => p.title)).toEqual([
      "Orion: Launch date: March (Maria, 2026-10-02)",
      "Orion: Database: PostgreSQL (me@storm.test, 2026-10-04)",
    ]);
    // Its cost is part of the month's spend (the budget, the Costs page).
    expect(await llmSpendSince(db.client, userId, new Date(0))).toBeCloseTo(0.007, 5);
    // Nothing written before the user picks.
    expect(await db.client.topicFact.count({ where: { topicId: orion } })).toBe(0);
  });

  it("over the monthly budget it stops; an email gone from the mailbox is left out", async () => {
    const gone = email({ subject: "Kickoff" });
    const mail: MailConnector = {
      fetch: () => Promise.reject(new Error("unused")),
      send: () => Promise.reject(new Error("unused")),
      attachments: () => Promise.reject(new Error("unused")),
      recent: (_user, request) => Promise.resolve(request.mailbox === "INBOX" ? [gone] : []),
      thread: () => Promise.resolve([]),
    };
    const batches = new FakeBatches(() => ({ results: [] }));
    const make = (over: boolean) =>
      new TopicBackfills(
        db.client,
        mail,
        batches,
        new ModelRouter(() => Promise.resolve(null)),
        { overBudget: () => Promise.resolve(over) },
        () => Promise.resolve(),
      );
    const { topicBackfillId } = await db.client.topicBackfill.create({ data: { userId, topicId: orion, months: 1, documents: false } });
    await make(false).step(topicBackfillId);
    await db.client.topicBackfill.update({ where: { topicBackfillId }, data: { status: "SCREENING" } });
    await make(true).step(topicBackfillId);
    expect(await db.client.topicBackfill.findUniqueOrThrow({ where: { topicBackfillId } })).toMatchObject({
      status: "FAILED",
      error: "The monthly LLM budget is reached",
    });

    await db.client.topicBackfill.update({ where: { topicBackfillId }, data: { status: "SCREENING", error: null } });
    await make(false).step(topicBackfillId);
    // Its only email is gone: nothing to read, nothing sent to the Batch API.
    expect(batches.batches.size).toBe(0);
    expect((await db.client.topicBackfill.findUniqueOrThrow({ where: { topicBackfillId } })).status).toBe("REVIEW");
  });
});

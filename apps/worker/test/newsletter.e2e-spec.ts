import { payloadHash } from "@realentity/storm-crypto";
import { createPrismaConnection, type Prisma, type PrismaConnection } from "@realentity/storm-db";
import { entityItem, readAppSource } from "@realentity/storm-shared";
import { exampleYaml } from "@realentity/storm-shared/example-files";
import { defaultCatalog, PipelineCompiler } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { DedupeStep, SaveStep } from "../src/steps/data-steps";
import { ReadStep } from "../src/steps/entity-steps";
import { MapStep } from "../src/steps/map-alert-steps";
import { bindSlots, Counting, createVersion } from "./support/test-steps";

jest.setTimeout(60_000);

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

/** An email as email.fetch reads it. */
const email = (uid: number, from: string, subject: string, text: string, inReplyTo: string | null = null) => ({
  uid,
  messageId: `<${uid}@mail.example>`,
  threadId: inReplyTo ?? `<${uid}@mail.example>`,
  inReplyTo,
  references: inReplyTo ? [inReplyTo] : [],
  from,
  fromName: null,
  replyTo: from,
  to: ["me@mail.example"],
  cc: [],
  subject,
  date: hoursAgo(5),
  text,
  attachments: [],
  account: null,
});

// M58-T9: the Newsletter App: links collected over the week, the ones you pick written up on Friday, one email per
// subscriber approved as a batch, a reply "unsubscribe" keeping its sender out of later issues
describe("examples/apps/newsletter.yaml", () => {
  const compiler = new PipelineCompiler(defaultCatalog());
  const appSource = exampleYaml("apps/newsletter.yaml");
  const definition = readAppSource(appSource);
  let db: PrismaConnection;
  let userId: string;
  let appId: string;
  let inbox: ReturnType<typeof email>[];
  let write: Counting;
  let send: Counting;
  let runner: PipelineRunner;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(async () => {
    const app = await db.client.app.create({ data: { userId, name: "Newsletter" } });
    const version = await db.client.appVersion.create({ data: { appId: app.appId, version: 1, definition: {}, source: appSource } });
    await db.client.app.update({ where: { appId: app.appId }, data: { currentVersionId: version.appVersionId } });
    appId = app.appId;
    for (const [email, name] of [["ana@mail.example", "Ana"], ["bo@mail.example", "Bo"], ["cy@mail.example", "Cy"]]) {
      await db.client.dataEntity.create({ data: { appId, type: "Subscriber", key: email, value: { email }, mine: { name } } });
    }
    inbox = [
      email(1, "me@mail.example", "Fwd: A good read on queues #link", "---------- Forwarded message ---------\nSee https://blog.example/queues for the details."),
      email(2, "shop@mail.example", "Weekly deals", "Deals at https://shop.example/deals"),
      email(3, "bo@mail.example", "Re: Weekly links · 2026-11-13", "Unsubscribe please\n\n> To stop, reply to this email with the word unsubscribe.", "<issue@mail.example>"),
      email(4, "cy@mail.example", "Re: Weekly links · 2026-11-13", "Loved it, thanks!\n\n> To stop, reply to this email with the word unsubscribe.", "<issue@mail.example>"),
    ];
    write = new Counting("llm.generate", () => ({ text: "Two good reads this week.\n\nQueues\nhttps://blog.example/queues" }));
    send = new Counting("email.send", (input) => ({ messageId: `<sent-${send.calls.length}@mail.example>`, accepted: [input.to], from: "me@mail.example" }));
    runner = new PipelineRunner(
      db.client,
      defaultCatalog(),
      new ExecutorRegistry([
        new ReadStep(db.client),
        new SaveStep(db.client),
        new MapStep(),
        new DedupeStep(db.client),
        new Counting("email.fetch", () => ({ messages: inbox })),
        new Counting("http.fetch", () => ({
          items: [
            { title: "Release radar", url: "https://github.blog/radar", published: hoursAgo(30), summary: "What shipped.", id: "1", source: "github.blog" },
            { title: "Old news", url: "https://github.blog/old", published: hoursAgo(24 * 20), summary: "Old.", id: "2", source: "github.blog" },
          ],
          json: null,
          text: "",
          documents: [],
        })),
        write,
        send,
      ]),
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

  const rows = async (type: string) =>
    Object.fromEntries(
      (await db.client.dataEntity.findMany({ where: { appId, type }, orderBy: { key: "asc" } })).map((r) => [r.key, { stage: r.stage, ...entityItem(r.value, r.mine) }]),
    );
  const start = async (pipeline: string) => {
    const versionId = await createVersion(db.client, userId, exampleYaml(`${pipeline}.yaml`), compiler, { app: definition });
    await bindSlots(db.client, versionId, {}, { title: "Weekly links" });
    return runner.start(versionId, { trigger: "schedule", triggerData: {} });
  };
  /** Each gate as the inbox decides it: the review picks `pick` (by url); an email is approved unless `hold` says no. */
  const decide = async (runId: string, pick: string[] = [], hold: (to: string) => boolean = () => false) => {
    for (let status = await runner.advance(runId); status !== "DONE"; status = await runner.advance(runId)) {
      if (status === "FAILED") {
        const failed = await db.client.step.findMany({ where: { runId, error: { not: null } }, select: { stepKey: true, error: true } });
        throw new Error(failed.map((f) => `${f.stepKey}: ${f.error}`).join("\n"));
      }
      expect(status).toBe("WAITING_FOR_USER");
      for (const p of await db.client.proposal.findMany({ where: { runId, status: "PENDING_REVIEW" } })) {
        const offered = p.originalPayload as { items?: { url: string }[]; to?: string };
        const payload = (p.stepKey === "pick" ? { items: offered.items!.filter((i) => pick.includes(i.url)) } : offered) as Prisma.InputJsonValue;
        const status = p.stepKey !== "pick" && hold(offered.to!) ? "REJECTED" : "APPROVED";
        await db.client.proposal.update({ where: { proposalId: p.proposalId }, data: { status, finalPayload: payload, payloadHash: payloadHash(payload) } });
      }
    }
  };
  const link = (url: string, title: string, note?: string) =>
    db.client.dataEntity.create({
      data: { appId, type: "Link", key: url, value: { url, title, source: "email", found: hoursAgo(10) }, mine: note ? { note } : {}, stage: "new" },
    });

  it("collects the links you forward with #link and the feeds' items of the week; a reply saying unsubscribe is kept; nothing twice", async () => {
    await decide(await start("collect-links"));
    expect(await rows("Link")).toEqual({
      "https://blog.example/queues": expect.objectContaining({ stage: "new", title: "A good read on queues", source: "email" }) as unknown,
      "https://github.blog/radar": expect.objectContaining({ stage: "new", title: "Release radar", source: "github.blog" }) as unknown,
    });
    expect(Object.keys(await rows("Unsubscribed"))).toEqual(["bo@mail.example"]);

    await decide(await start("collect-links"));
    expect(Object.keys(await rows("Link"))).toHaveLength(2);
  });

  it("the links you pick written up with your notes, one email to each subscriber but the unsubscribed; sent, the Issue and Links move on", async () => {
    await link("https://blog.example/queues", "Queues", "The best intro to queues I've read.");
    await link("https://blog.example/caches", "Caches");
    await link("https://blog.example/meh", "Meh");
    await db.client.dataEntity.create({ data: { appId, type: "Unsubscribed", key: "bo@mail.example", value: { email: "bo@mail.example" } } });

    await decide(await start("newsletter-issue"), ["https://blog.example/queues", "https://blog.example/caches"]);
    expect(write.calls).toHaveLength(1);
    const context = write.calls[0].context as { newsletter: string; links: { url: string; note?: string }[] };
    expect(context.newsletter).toBe("Weekly links");
    expect(context.links.map((l) => l.url).sort()).toEqual(["https://blog.example/caches", "https://blog.example/queues"]);
    expect(context.links.find((l) => l.url.endsWith("queues"))?.note).toBe("The best intro to queues I've read.");

    expect(send.calls.map((c) => c.to)).toEqual(["ana@mail.example", "cy@mail.example"]);
    const day = new Date().toISOString().slice(0, 10);
    expect(send.calls[0]).toMatchObject({ subject: `Weekly links · ${day}` });
    expect(send.calls[0].body).toMatch(/^Hello Ana,\n\nTwo good reads/);
    expect(send.calls[0].body).toMatch(/To stop, reply to this email with the word unsubscribe\.$/);

    expect(await rows("Issue")).toEqual({ [day]: expect.objectContaining({ stage: "sent", recipients: 2, links: 2, title: `Weekly links · ${day}` }) as unknown });
    const links = await rows("Link");
    expect(links["https://blog.example/queues"]).toMatchObject({ stage: "used", issue: day, note: "The best intro to queues I've read." });
    expect(links["https://blog.example/caches"]).toMatchObject({ stage: "used", issue: day });
    expect(links["https://blog.example/meh"]).toMatchObject({ stage: "skipped" });
  });

  it("every email turned down: nothing sent, the Issue stays drafted and the Links new", async () => {
    await link("https://blog.example/queues", "Queues");
    await decide(await start("newsletter-issue"), ["https://blog.example/queues"], () => true);
    expect(send.calls).toEqual([]);
    expect(Object.values(await rows("Issue"))).toEqual([expect.objectContaining({ stage: "drafted" })]);
    expect(await rows("Link")).toMatchObject({ "https://blog.example/queues": { stage: "new" } });
  });

  it("no new links: nothing written or sent", async () => {
    await decide(await start("newsletter-issue"));
    expect(write.calls).toEqual([]);
    expect(send.calls).toEqual([]);
    expect(await rows("Issue")).toEqual({});
  });
});

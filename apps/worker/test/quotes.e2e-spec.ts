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

// M58-T5: the Quotes App: a request to the suppliers picked, answers read into quotes, one accepted, the rest thanked
describe("examples/apps/quotes.yaml", () => {
  const compiler = new PipelineCompiler(defaultCatalog());
  const appSource = exampleYaml("apps/quotes.yaml");
  const definition = readAppSource(appSource);
  let db: PrismaConnection;
  let userId: string;
  let appId: string;
  let inbox: Record<string, unknown>[];
  let send: Counting;
  let extract: Counting;
  let telegram: Counting;
  let runner: PipelineRunner;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  const create = (type: string, key: string, value: Record<string, unknown>, mine?: Record<string, unknown>, stage?: string) =>
    db.client.dataEntity.create({ data: { appId, type, key, value: value as Prisma.InputJsonObject, ...(mine ? { mine: mine as Prisma.InputJsonObject } : {}), ...(stage ? { stage } : {}) } });

  beforeEach(async () => {
    const app = await db.client.app.create({ data: { userId, name: "Quotes" } });
    const version = await db.client.appVersion.create({ data: { appId: app.appId, version: 1, definition: {}, source: appSource } });
    await db.client.app.update({ where: { appId: app.appId }, data: { currentVersionId: version.appVersionId } });
    appId = app.appId;
    inbox = [];
    send = new Counting("email.send", (input) => ({ messageId: `<ask-${send.calls.length}@mail.example>`, accepted: [input.to], from: "me@mail.example" }));
    extract = new Counting("llm.extract", () => ({
      values: { price: "€1,250.50", currency: "eur", deliveryDate: "2026-12-01", terms: "30 days net." },
      missing: [],
      found: true,
    }));
    telegram = new Counting("notify.telegram", () => ({ sent: true }));
    const fetch = new Counting("email.fetch", () => ({ messages: inbox }));
    runner = new PipelineRunner(db.client, defaultCatalog(), new ExecutorRegistry([new ReadStep(db.client), new SaveStep(db.client), new MapStep(), send, extract, telegram, fetch]));
    // Added on their forms: three suppliers, and a request to two of them.
    await create("Supplier", "Print Co", { name: "Print Co" }, { email: "sales@print.example" });
    await create("Supplier", "Fast Print", { name: "Fast Print" }, { email: "hello@fastprint.example" });
    await create("Supplier", "Third", { name: "Third" }, { email: "x@third.example" });
    await create("Request", "r1", { id: "r1" }, { title: "500 business cards", details: "Two-sided, matte.", needBy: "2026-12-10", suppliers: ["Print Co", "Fast Print"] });
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.app.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  const item = async (type: string, key: string) => {
    const row = await db.client.dataEntity.findUniqueOrThrow({ where: { appId_type_key: { appId, type, key } } });
    return entityItem(row.value, row.mine);
  };
  const stages = async () =>
    Object.fromEntries((await db.client.dataEntity.findMany({ where: { appId, type: "Quote" }, orderBy: { key: "asc" } })).map((r) => [r.key, r.stage]));
  /** Each gate the run waits at, decided as the inbox does, until the run ends. */
  const decideAll = async (runId: string, approve: (payload: { to: string }) => boolean = () => true) => {
    for (let status = await runner.advance(runId); status !== "DONE"; status = await runner.advance(runId)) {
      if (status === "FAILED") {
        const failed = await db.client.step.findMany({ where: { runId, error: { not: null } }, select: { stepKey: true, error: true } });
        throw new Error(failed.map((f) => `${f.stepKey}: ${f.error}`).join("\n"));
      }
      expect(status).toBe("WAITING_FOR_USER");
      const pending = await db.client.proposal.findMany({ where: { runId, status: "PENDING_REVIEW" } });
      for (const p of pending) {
        const payload = p.originalPayload as Prisma.InputJsonValue;
        const verdict = approve(p.originalPayload as { to: string }) ? "APPROVED" : "REJECTED";
        await db.client.proposal.update({ where: { proposalId: p.proposalId }, data: { status: verdict, finalPayload: payload, payloadHash: payloadHash(payload) } });
      }
    }
  };
  const press = async (pipeline: string, type: string, key: string, action: string) =>
    runner.start(await createVersion(db.client, userId, exampleYaml(`${pipeline}.yaml`), compiler, { app: definition }), {
      trigger: "event",
      triggerData: { app: "Quotes", appId, type, key, item: await item(type, key), action },
    });

  it("Ask for quotes: the request to each supplier picked, as one batch; each one sent is a Quote asked", async () => {
    const runId = await press("quote-ask", "Request", "r1", "Ask for quotes");
    expect(await runner.advance(runId)).toBe("WAITING_FOR_USER");
    const batch = await db.client.proposal.findMany({ where: { runId }, orderBy: [{ itemIndex: "asc" }] });
    expect(batch.map((p) => (p.originalPayload as { to: string }).to)).toEqual(["hello@fastprint.example", "sales@print.example"]);
    expect(batch[1].originalPayload).toMatchObject({ subject: "Request for a quote: 500 business cards" });
    expect((batch[1].originalPayload as { body: string }).body).toContain("Two-sided, matte.\n\nI need it by 2026-12-10.");

    await decideAll(runId, (p) => p.to === "sales@print.example");
    expect(send.calls.map((c) => c.to)).toEqual(["sales@print.example"]);
    expect(await stages()).toEqual({ "r1:Print Co": "asked" });
    expect(await item("Quote", "r1:Print Co")).toMatchObject({ request: "r1", supplier: "Print Co", requestTitle: "500 business cards", messageId: "<ask-1@mail.example>" });
  });

  it("an answer in a request's thread is read into its Quote, quoted; you're told", async () => {
    await create("Quote", "r1:Print Co", { id: "r1:Print Co", request: "r1", requestTitle: "500 business cards", supplier: "Print Co", messageId: "<ask-1@mail.example>" }, undefined, "asked");
    await create("Quote", "r1:Fast Print", { id: "r1:Fast Print", request: "r1", requestTitle: "500 business cards", supplier: "Fast Print", messageId: "<ask-2@mail.example>" }, undefined, "asked");
    inbox = [
      { messageId: "<a@print.example>", threadId: "<ask-1@mail.example>", inReplyTo: "<ask-1@mail.example>", from: "sales@print.example", subject: "Re: Request for a quote", text: "EUR 1,250.50" },
      { messageId: "<n@news.example>", threadId: "<n@news.example>", inReplyTo: null, from: "news@news.example", subject: "News", text: "Sale" },
    ].map((m) => ({ uid: 1, references: [], fromName: null, replyTo: m.from, to: ["me@mail.example"], cc: [], date: "2026-11-21T08:00:00.000Z", attachments: [], account: null, ...m }));
    const runId = await runner.start(await createVersion(db.client, userId, exampleYaml("quote-read.yaml"), compiler, { app: definition }), { trigger: "schedule", triggerData: {} });
    await decideAll(runId);
    expect(extract.calls).toHaveLength(1);
    expect(await stages()).toEqual({ "r1:Fast Print": "asked", "r1:Print Co": "quoted" });
    expect(await item("Quote", "r1:Print Co")).toMatchObject({ price: 1250.5, currency: "EUR", deliveryDate: "2026-12-01", terms: "30 days net.", messageId: "<ask-1@mail.example>" });
    expect(telegram.calls.map((c) => c.text)).toEqual(["A quote for 500 business cards from Print Co: 1250.5 EUR. Compare them on the request's page."]);
  });

  it("Accept: its supplier told, the request's other suppliers thanked, each approved; accepted and declined", async () => {
    const quote = (supplier: string, stage: string, request = "r1") =>
      create("Quote", `${request}:${supplier}`, { id: `${request}:${supplier}`, request, requestTitle: "500 business cards", supplier, price: 100 }, undefined, stage);
    await quote("Print Co", "quoted");
    await quote("Fast Print", "quoted");
    await quote("Third", "asked");
    await quote("Third", "quoted", "r2");

    await decideAll(await press("quote-accept", "Quote", "r1:Print Co", "Accept"));
    expect(send.calls.map((c) => [c.to, c.subject])).toEqual([
      ["sales@print.example", "Your quote for 500 business cards: accepted"],
      ["hello@fastprint.example", "Your quote for 500 business cards"],
      ["x@third.example", "Your quote for 500 business cards"],
    ]);
    expect(await stages()).toEqual({ "r1:Fast Print": "declined", "r1:Print Co": "accepted", "r1:Third": "declined", "r2:Third": "quoted" });
  });

  it("Accept with the thank-you to one of them rejected: that quote stays as it was", async () => {
    await create("Quote", "r1:Print Co", { id: "r1:Print Co", request: "r1", requestTitle: "500 business cards", supplier: "Print Co" }, undefined, "quoted");
    await create("Quote", "r1:Fast Print", { id: "r1:Fast Print", request: "r1", requestTitle: "500 business cards", supplier: "Fast Print" }, undefined, "quoted");
    await decideAll(await press("quote-accept", "Quote", "r1:Print Co", "Accept"), (p) => p.to !== "hello@fastprint.example");
    expect(await stages()).toEqual({ "r1:Fast Print": "quoted", "r1:Print Co": "accepted" });
  });
});

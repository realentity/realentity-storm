import { createPrismaConnection, type Prisma, type PrismaConnection } from "@realentity/storm-db";
import { emptyUsage, ModelRouter, type LlmClient, type LlmFile, type LlmUsage, type StructuredRequest } from "@realentity/storm-llm";
import { entityItem, readAppSource } from "@realentity/storm-shared";
import { defaultCatalog, PipelineCompiler } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { type z } from "zod";
import { recordFile, storeFile } from "@realentity/storm-files";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { AppFileStore } from "../src/steps/app-file-steps";
import { SaveStep } from "../src/steps/data-steps";
import { ReadStep } from "../src/steps/entity-steps";
import { ExtractStep } from "../src/steps/llm-steps";
import { MapStep } from "../src/steps/map-alert-steps";
import { Counting, createVersion } from "./support/test-steps";

jest.setTimeout(60_000);

const read = (file: string) => readFileSync(join(__dirname, "../../../pipelines", file), "utf8");

/** Reads a receipt the way a model would: from the photo it is shown. */
class ReceiptReader implements LlmClient {
  seen: LlmFile[][] = [];
  structured<S extends z.ZodObject>(request: StructuredRequest<S>): Promise<{ output: z.infer<S>; usage: LlmUsage }> {
    this.seen.push(request.files ?? []);
    const values = { kind: "receipt", merchant: "Northwind Appliances", amount: "499.00", currency: "EUR", date: "2026-11-10", warrantyUntil: "2028-11-10" };
    return Promise.resolve({ output: request.schema.parse({ values: Object.entries(values).map(([name, value]) => ({ name, value })) }), usage: { ...emptyUsage(), calls: 1 } });
  }
}

// M48-I1: the Tasks and Papers Apps' pipelines (V1 with a stand-in model)
describe("Tasks and Papers", () => {
  let db: PrismaConnection;
  let userId: string;
  let root: string;
  let telegram: Counting;
  let reader: ReceiptReader;
  let runner: PipelineRunner;
  const compiler = new PipelineCompiler(defaultCatalog());

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    root = await mkdtemp(join(tmpdir(), "storm-papers-"));
  });

  beforeEach(() => {
    telegram = new Counting("notify.telegram", () => ({ sent: true }));
    reader = new ReceiptReader();
    const store = new AppFileStore(root);
    runner = new PipelineRunner(
      db.client,
      defaultCatalog(),
      new ExecutorRegistry([
        new ReadStep(db.client),
        new SaveStep(db.client, root),
        new MapStep(),
        new ExtractStep(reader, new ModelRouter(() => Promise.resolve(null))).withFiles(db.client, store),
        telegram,
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
    await rm(root, { recursive: true, force: true });
  });

  const install = async (file: string) => {
    const source = read(file);
    const app = await db.client.app.create({ data: { userId, name: readAppSource(source).name } });
    const version = await db.client.appVersion.create({ data: { appId: app.appId, version: 1, definition: {}, source } });
    await db.client.app.update({ where: { appId: app.appId }, data: { currentVersionId: version.appVersionId } });
    return { appId: app.appId, definition: readAppSource(source) };
  };
  const add = (appId: string, type: string, key: string, mine: Record<string, unknown>, stage: string | null = null) =>
    db.client.dataEntity.create({ data: { appId, type, key, value: { id: key }, mine: mine as Prisma.InputJsonObject, stage } });
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

  it("pipelines/tasks-due.yaml: the open tasks due today or overdue in one message, nothing when there are none", async () => {
    const { appId, definition } = await install("apps/tasks.yaml");
    const versionId = await createVersion(db.client, userId, read("tasks-due.yaml"), compiler, { app: definition });
    const run = async () => {
      const runId = await runner.start(versionId, { trigger: "manual" });
      expect(await runner.advance(runId)).toBe("DONE");
    };
    await add(appId, "Task", "t1", { title: "Renew the passport", due: day(-3) }, "open");
    await add(appId, "Task", "t2", { title: "Water the plants", due: day(0) }, "open");
    await add(appId, "Task", "t3", { title: "Book the dentist", due: day(5) }, "open");
    await add(appId, "Task", "t4", { title: "Pay the rent", due: day(-1) }, "done");
    await run();
    expect(telegram.calls.map((c) => c.text)).toEqual([`Due: • Renew the passport (since ${day(-3)})\n• Water the plants`]);
    await db.client.dataEntity.deleteMany({ where: { appId, key: { in: ["t1", "t2"] } } });
    await run();
    expect(telegram.calls).toHaveLength(1);
  });

  it("pipelines/read-paper.yaml: a paper's photo read into its fields; what you typed stays", async () => {
    const { appId, definition } = await install("apps/papers.yaml");
    const versionId = await createVersion(db.client, userId, read("read-paper.yaml"), compiler, { app: definition });
    const photo = await sharp({ create: { width: 2400, height: 3200, channels: 3, background: "#f4f1ea" } }).jpeg().toBuffer();
    const stored = await storeFile(root, photo, "receipt.jpg", "file");
    const document = await recordFile(db.client, appId, "Paper", "document", stored);
    await db.client.appFile.update({ where: { appFileId: document.id }, data: { key: "p1" } });
    // Added on the form: the title and the document, and the merchant typed as you know it.
    const entity = await add(appId, "Paper", "p1", { title: "Washing machine", document, merchant: "Northwind" });
    const item = entityItem(entity.value, entity.mine);

    const runId = await runner.start(versionId, { trigger: "event", triggerData: { app: "Papers", appId, type: "Paper", key: "p1", item, before: null, changed: ["title", "document", "merchant"], stage: null, by: "me" } });
    expect(await runner.advance(runId)).toBe("DONE");
    expect(reader.seen[0]).toMatchObject([{ name: "receipt.jpg", mime: "image/jpeg" }]);
    const saved = await db.client.dataEntity.findUniqueOrThrow({ where: { appId_type_key: { appId, type: "Paper", key: "p1" } } });
    expect(entityItem(saved.value, saved.mine)).toEqual({
      id: "p1",
      title: "Washing machine",
      document,
      merchant: "Northwind",
      kind: "receipt",
      amount: 499,
      currency: "EUR",
      date: "2026-11-10",
      warrantyUntil: "2028-11-10",
    });
  });
});

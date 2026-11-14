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
import { AppFileStore, FileKeepStep } from "../src/steps/app-file-steps";
import { type MailConnector } from "../src/mail/mail-connector";
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
  let photo: Buffer;
  /** The Bot API's getFile and file download, for the photos the tests send. */
  let downloads: string[];
  const botApi: typeof fetch = (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    downloads.push(url.replace(/bot[^/]+/, "bot<token>"));
    if (url.endsWith("/getFile")) return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { file_path: "photos/file_7.jpg", file_size: photo.length } })));
    return Promise.resolve(new Response(new Uint8Array(photo)));
  };
  const compiler = new PipelineCompiler(defaultCatalog());

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    root = await mkdtemp(join(tmpdir(), "storm-papers-"));
    photo = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: "#e8e2d4" } }).jpeg().toBuffer();
  });

  beforeEach(() => {
    telegram = new Counting("notify.telegram", () => ({ sent: true }));
    reader = new ReceiptReader();
    downloads = [];
    const store = new AppFileStore(root);
    runner = new PipelineRunner(
      db.client,
      defaultCatalog(),
      new ExecutorRegistry([
        new ReadStep(db.client),
        new SaveStep(db.client, root),
        new MapStep(),
        new ExtractStep(reader, new ModelRouter(() => Promise.resolve(null))).withFiles(db.client, store),
        new FileKeepStep(db.client, store, {} as MailConnector, undefined, 25, { config: { botToken: "123:test", chatId: "4242" }, fetch: botApi }),
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

  // M49-I1 (the worker's half): /task, /memo with a photo, /paper with a photo
  describe("from Telegram", () => {
    const command = (name: string, text: string, file: Record<string, unknown> | null = null) => ({
      command: name,
      text,
      file,
      messageId: 7,
      sentAt: "2026-11-14T08:30:00.000Z",
    });
    const sentPhoto = { telegramFileId: "AgACAgQAAxkBAAI", name: "photo-1763109000.jpg", mime: "image/jpeg", size: 1 };
    const runCommand = async (file: string, app: string, data: Record<string, unknown>) => {
      const { appId, definition } = await install(app);
      const versionId = await createVersion(db.client, userId, read(file), compiler, { app: definition });
      const runId = await runner.start(versionId, { trigger: "telegram", triggerData: data });
      expect(await runner.advance(runId)).toBe("DONE");
      return appId;
    };
    const only = async (appId: string, type: string) => {
      const rows = await db.client.dataEntity.findMany({ where: { appId, type } });
      expect(rows).toHaveLength(1);
      return entityItem(rows[0].value, rows[0].mine);
    };

    it("pipelines/task-from-telegram.yaml: /task Renew the passport adds an open task", async () => {
      const appId = await runCommand("task-from-telegram.yaml", "apps/tasks.yaml", command("task", "Renew the passport\nbefore the trip"));
      expect(await only(appId, "Task")).toMatchObject({ title: "Renew the passport", id: expect.stringMatching(/^[a-z0-9]{12}$/) as unknown });
      expect(telegram.calls.map((c) => c.text)).toEqual(["Added: Renew the passport"]);
    });

    it("pipelines/memo-from-telegram.yaml: a photo with /memo kept with its text; the photo downloaded from the bot", async () => {
      const appId = await runCommand("memo-from-telegram.yaml", "apps/memos.yaml", command("memo", "Wi-Fi at the cottage", sentPhoto));
      const memo = await only(appId, "Memo");
      expect(memo).toMatchObject({ title: "Wi-Fi at the cottage", text: "Wi-Fi at the cottage", photo: { name: "photo-1763109000.jpg", mime: "image/jpeg", size: photo.length } });
      expect(downloads).toEqual(["https://api.telegram.org/bot<token>/getFile", "https://api.telegram.org/file/bot<token>/photos/file_7.jpg"]);
      expect(telegram.calls.map((c) => c.text)).toEqual(["Kept: Wi-Fi at the cottage"]);
    });

    it("pipelines/paper-from-telegram.yaml: a photo with /paper becomes a paper with its document", async () => {
      const appId = await runCommand("paper-from-telegram.yaml", "apps/papers.yaml", command("paper", "Washing machine", sentPhoto));
      expect(await only(appId, "Paper")).toMatchObject({ title: "Washing machine", document: { mime: "image/jpeg" } });
      expect(telegram.calls.map((c) => c.text)).toEqual(["Kept: Washing machine. Reading it now."]);
    });
  });
});

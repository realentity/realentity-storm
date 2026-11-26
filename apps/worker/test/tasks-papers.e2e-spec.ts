import { payloadHash } from "@realentity/storm-crypto";
import { exampleYaml } from "@realentity/storm-shared/example-files";
import { createPrismaConnection, type Prisma, type PrismaConnection, type Proposal } from "@realentity/storm-db";
import { emptyUsage, ModelRouter, type LlmClient, type LlmFile, type LlmUsage, type StructuredRequest } from "@realentity/storm-llm";
import { entityItem, readAppSource } from "@realentity/storm-shared";
import { defaultCatalog, PipelineCompiler } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { type z } from "zod";
import { recordFile, storeFile } from "@realentity/storm-files";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { AppFileStore, FileKeepStep } from "../src/steps/app-file-steps";
import { type MailConnector, type OutgoingMail } from "../src/mail/mail-connector";
import { EmailSendStep } from "../src/steps/email-steps";
import { SaveStep } from "../src/steps/data-steps";
import { ReadStep } from "../src/steps/entity-steps";
import { ExtractStep } from "../src/steps/llm-steps";
import { MapStep } from "../src/steps/map-alert-steps";
import { bindSlots, Counting, createVersion } from "./support/test-steps";

jest.setTimeout(60_000);

const read = (file: string) => exampleYaml(file);

/** Reads a receipt the way a model would: from the photo it is shown. */
class ReceiptReader implements LlmClient {
  seen: LlmFile[][] = [];
  structured<S extends z.ZodObject>(request: StructuredRequest<S>): Promise<{ output: z.infer<S>; usage: LlmUsage }> {
    this.seen.push(request.files ?? []);
    const values = { kind: "receipt", merchant: "Northwind Appliances", amount: "499.00", currency: "EUR", date: "2026-11-10", category: "equipment", warrantyUntil: "2028-11-10" };
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

  it("examples/apps/tasks.yaml: the open tasks due today or overdue in one message, nothing when there are none", async () => {
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

  it("examples/apps/papers.yaml: a paper's photo read into its fields; what you typed stays", async () => {
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
      category: "equipment",
      warrantyUntil: "2028-11-10",
    });
  });

  // M58-T1: a warranty claim and a contract's cancellation to the Merchant you chose, a contract's reminder, last
  // month's expenses to your accountant; every email after you Act.
  describe("claims, contracts and expenses", () => {
    let generate: Counting;
    let send: Counting;
    let later: Counting;
    let cancel: Counting;
    let actions: PipelineRunner;

    beforeEach(() => {
      generate = new Counting("llm.generate", () => ({ text: "Dear Northwind, the washing machine stopped spinning." }));
      send = new Counting("email.send", (input) => ({ messageId: "<m1@example.com>", accepted: [input.to], from: "me@example.com" }));
      later = new Counting("flow.later", (input) => ({ scheduledStartId: "s1", fireAt: input.at, replaced: 0 }));
      cancel = new Counting("flow.cancel", () => ({ cancelled: 0 }));
      actions = new PipelineRunner(
        db.client,
        defaultCatalog(),
        new ExecutorRegistry([new ReadStep(db.client), new SaveStep(db.client, root), new MapStep(), generate, send, later, cancel, telegram]),
      );
    });

    const proposals = (runId: string): Promise<Proposal[]> => db.client.proposal.findMany({ where: { runId }, orderBy: [{ itemIndex: "asc" }] });
    const approve = async (proposal: Proposal, edit = (p: Record<string, unknown>) => p) => {
      const finalPayload = edit(structuredClone(proposal.originalPayload as Record<string, unknown>));
      await db.client.proposal.update({
        where: { proposalId: proposal.proposalId },
        data: { status: "APPROVED", finalPayload: finalPayload as Prisma.InputJsonValue, payloadHash: payloadHash(finalPayload) },
      });
    };
    /** Advances the run to its end, or says which step failed and why. */
    const finish = async (runId: string) => {
      const status = await actions.advance(runId);
      if (status === "FAILED") {
        const failed = await db.client.step.findMany({ where: { runId, error: { not: null } }, select: { stepKey: true, error: true } });
        throw new Error(failed.map((f) => `${f.stepKey}: ${f.error}`).join("\n"));
      }
      expect(status).toBe("DONE");
    };
    const press = async (file: string, appId: string, definition: ReturnType<typeof readAppSource>, key: string) => {
      const versionId = await createVersion(db.client, userId, read(file), compiler, { app: definition });
      const entity = await db.client.dataEntity.findUniqueOrThrow({ where: { appId_type_key: { appId, type: "Paper", key } } });
      const item = entityItem(entity.value, entity.mine);
      return actions.start(versionId, { trigger: "event", triggerData: { app: "Papers", appId, type: "Paper", key, item, action: "Claim warranty" } });
    };

    /** A paper's document, kept for it. */
    const documentOf = async (appId: string, key: string, name: string, content: Buffer) => {
      const document = await recordFile(db.client, appId, "Paper", "document", await storeFile(root, content, name, "file"));
      await db.client.appFile.update({ where: { appFileId: document.id }, data: { key } });
      return document;
    };
    const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`);

    it("a warranty claim goes to the merchant you chose, its receipt attached, after you Act; without one, nothing and why", async () => {
      const { appId, definition } = await install("apps/papers.yaml");
      await add(appId, "Merchant", "Northwind", { name: "Northwind", email: "service@northwind.example" });
      const document = await documentOf(appId, "p1", "receipt.pdf", pdf("washing machine"));
      await add(appId, "Paper", "p1", { title: "Washing machine", kind: "receipt", merchant: "Northwind Appliances", date: "2026-11-10", warrantyUntil: "2028-11-10", seller: "Northwind", document });
      await add(appId, "Paper", "p2", { title: "Kettle", kind: "receipt" });

      const runId = await press("warranty-claim.yaml", appId, definition, "p1");
      expect(await actions.advance(runId)).toBe("WAITING_FOR_USER");
      expect(generate.calls[0]).toMatchObject({ context: { paper: { title: "Washing machine" }, merchant: { email: "service@northwind.example" } } });
      const [gate] = await proposals(runId);
      // M59-T1: the receipt, shown at the gate by its name and size.
      expect(gate.originalPayload).toMatchObject({ to: "service@northwind.example", subject: "Warranty claim: Washing machine", attachments: [document] });
      await approve(gate);
      await finish(runId);
      expect(send.calls).toEqual([expect.objectContaining({ to: "service@northwind.example", body: "Dear Northwind, the washing machine stopped spinning." })]);
      expect(telegram.calls).toEqual([]);

      await finish(await press("warranty-claim.yaml", appId, definition, "p2"));
      expect(send.calls).toHaveLength(1);
      expect(telegram.calls.map((c) => c.text)).toEqual([expect.stringContaining("No claim for Kettle: choose who to write to") as unknown]);
    });

    it("a contract's cancellation goes to its merchant, after you Act", async () => {
      const { appId, definition } = await install("apps/papers.yaml");
      await add(appId, "Merchant", "Fibrenet", { name: "Fibrenet", email: "contracts@fibrenet.example" });
      await add(appId, "Paper", "c1", { title: "Home internet", kind: "contract", endsOn: day(90), noticeDays: 30, seller: "Fibrenet" });
      const runId = await press("contract-cancel.yaml", appId, definition, "c1");
      expect(await actions.advance(runId)).toBe("WAITING_FOR_USER");
      await approve((await proposals(runId))[0]);
      await finish(runId);
      expect(send.calls).toEqual([expect.objectContaining({ to: "contracts@fibrenet.example", subject: "Cancellation: Home internet" })]);
    });

    it("a contract is told two weeks before its notice runs out; no longer a contract, the reminder is cancelled", async () => {
      const { appId, definition } = await install("apps/papers.yaml");
      // Saved first: contract-watch names it.
      const reminder = await createVersion(db.client, userId, read("contract-reminder.yaml"), compiler, { app: definition });
      const watch = await createVersion(db.client, userId, read("contract-watch.yaml"), compiler, { app: definition });
      const changed = async (item: Record<string, unknown>) => {
        const runId = await actions.start(watch, { trigger: "event", triggerData: { app: "Papers", appId, type: "Paper", key: "c1", item, before: null, changed: ["endsOn"], stage: null, by: "me" } });
        await finish(runId);
      };
      await changed({ id: "c1", title: "Home internet", kind: "contract", endsOn: day(90), noticeDays: 30 });
      expect(later.calls).toEqual([expect.objectContaining({ pipeline: "Papers · Contract reminder", at: `${day(90 - 30 - 14)}T09:00`, key: "contract:c1" })]);
      expect(cancel.calls).toEqual([]);
      await changed({ id: "c1", title: "Home internet", kind: "other", endsOn: day(90) });
      expect(later.calls).toHaveLength(1);
      expect(cancel.calls).toEqual([{ key: "contract:c1" }]);

      const paper = { id: "c1", title: "Home internet", merchant: "Fibrenet", kind: "contract", endsOn: "2027-03-31", noticeDays: 30 };
      const runId = await actions.start(reminder, { trigger: "event", triggerData: { data: { paper } } });
      await finish(runId);
      expect(telegram.calls.map((c) => c.text)).toEqual([
        "Contract ending: Home internet (Fibrenet) ends on 2027-03-31. To cancel it, tell them by 2027-03-01. Keep it, change it, or press Cancel contract on its page.",
      ]);
    });

    it("last month's receipts and invoices, the ones you keep, to your accountant after you Act", async () => {
      const { appId, definition } = await install("apps/papers.yaml");
      const thisMonth = new Date().toISOString().slice(0, 7);
      const first = new Date(`${thisMonth}-01T00:00:00Z`);
      const last = new Date(first.getTime() - 86_400_000).toISOString().slice(0, 7);
      // M59-T1: the laptop's invoice and the lunch's receipt kept; the train ticket has no document.
      const invoice = await documentOf(appId, "e1", "laptop-invoice.pdf", pdf("laptop"));
      const lunch = await documentOf(appId, "e4", "lunch.pdf", pdf("lunch"));
      await add(appId, "Paper", "e1", { title: "Laptop", kind: "invoice", merchant: "Contoso", amount: 1200, currency: "EUR", date: `${last}-03`, category: "equipment", document: invoice });
      await add(appId, "Paper", "e2", { title: "Train", kind: "receipt", merchant: "Rail", amount: 35.5, currency: "EUR", date: `${last}-12`, category: "travel" });
      await add(appId, "Paper", "e3", { title: "Groceries", kind: "receipt", amount: 80, currency: "EUR", date: `${last}-15`, category: "personal" });
      await add(appId, "Paper", "e4", { title: "Lunch", kind: "receipt", merchant: "Cafe", amount: 20, currency: "EUR", date: `${last}-20`, category: "meals", document: lunch });
      await add(appId, "Paper", "e5", { title: "Monitor", kind: "invoice", amount: 300, currency: "EUR", date: `${thisMonth}-01` });
      await add(appId, "Paper", "e6", { title: "Phone", kind: "warranty", amount: 600, currency: "EUR", date: `${last}-05` });
      const versionId = await createVersion(db.client, userId, read("expense-report.yaml"), compiler, { app: definition });
      await bindSlots(db.client, versionId, {}, { accountant: "books@accounting.example" });

      const runId = await actions.start(versionId, { trigger: "manual" });
      expect(await actions.advance(runId)).toBe("WAITING_FOR_USER");
      const [review] = await proposals(runId);
      const offered = (review.originalPayload as { items: { title: string }[] }).items;
      expect(offered.map((p) => p.title)).toEqual(["Laptop", "Train", "Lunch"]);
      // Lunch was with a friend: unticked.
      await approve(review, () => ({ items: offered.filter((p) => p.title !== "Lunch") }));
      expect(await actions.advance(runId)).toBe("WAITING_FOR_USER");
      const [, mail] = await proposals(runId);
      const label = new Date(`${last}-01T00:00:00Z`).toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
      expect(mail.originalPayload).toMatchObject({
        to: "books@accounting.example",
        subject: `Expenses for ${label}`,
        body: expect.stringContaining(`${last}-03  Contoso  equipment  1,200.00 EUR\n${last}-12  Rail  travel  35.50 EUR\n\nTotal: 1,235.50 EUR`) as unknown,
        // The kept papers' documents: not the lunch's, unticked.
        attachments: [invoice],
      });
      await approve(mail);
      await finish(runId);
      expect(send.calls).toHaveLength(1);
    });

    // M59-T1: email.send itself: the approved files as they were kept, only the pipeline's App's.
    it("sends the receipt as it was kept; a file changed since, or another App's, sends nothing", async () => {
      const sent: OutgoingMail[] = [];
      const mail = {
        send: (_who: unknown, message: OutgoingMail) => (sent.push(message), Promise.resolve({ messageId: "<m2@example.com>", accepted: [message.to], from: "me@example.com" })),
      } as unknown as MailConnector;
      const sending = new PipelineRunner(
        db.client,
        defaultCatalog(),
        new ExecutorRegistry([new ReadStep(db.client), new MapStep(), generate, new EmailSendStep(mail, { prisma: db.client, store: new AppFileStore(root) }), telegram]),
      );
      const { appId, definition } = await install("apps/papers.yaml");
      await add(appId, "Merchant", "Northwind", { name: "Northwind", email: "service@northwind.example" });
      const content = pdf("washing machine");
      const document = await documentOf(appId, "p1", "receipt.pdf", content);
      await add(appId, "Paper", "p1", { title: "Washing machine", kind: "receipt", seller: "Northwind", document });
      const versionId = await createVersion(db.client, userId, read("warranty-claim.yaml"), compiler, { app: definition });
      const entity = await db.client.dataEntity.findUniqueOrThrow({ where: { appId_type_key: { appId, type: "Paper", key: "p1" } } });
      const claim = async (edit?: (p: Record<string, unknown>) => Record<string, unknown>) => {
        const runId = await sending.start(versionId, { trigger: "event", triggerData: { app: "Papers", appId, type: "Paper", key: "p1", item: entityItem(entity.value, entity.mine), action: "Claim warranty" } });
        expect(await sending.advance(runId)).toBe("WAITING_FOR_USER");
        await approve((await proposals(runId))[0], edit);
        const status = await sending.advance(runId);
        const failed = await db.client.step.findFirst({ where: { runId, stepKey: "send", error: { not: null } }, select: { error: true } });
        return { status, error: failed?.error ?? null };
      };

      expect(await claim()).toEqual({ status: "DONE", error: null });
      expect(sent).toHaveLength(1);
      expect(sent[0].attachments).toEqual([{ filename: "receipt.pdf", contentType: "application/pdf", content }]);

      // Another App's file named instead (an edit at the gate): not found in this App, nothing sent.
      const other = await db.client.app.create({ data: { userId, name: "Elsewhere" } });
      const foreign = await recordFile(db.client, other.appId, "Paper", "document", await storeFile(root, pdf("not yours"), "other.pdf", "file"));
      await db.client.appFile.update({ where: { appFileId: foreign.id }, data: { key: "x1" } });
      expect(await claim((p) => ({ ...p, attachments: [foreign] }))).toEqual({ status: "FAILED", error: expect.stringContaining(`No file ${foreign.id} in this pipeline's App`) as unknown });

      // The kept file changed on disk since it was approved: nothing sent.
      const row = await db.client.appFile.findUniqueOrThrow({ where: { appFileId: document.id } });
      await writeFile(join(root, row.path), pdf("something else, same length"));
      expect(await claim()).toEqual({ status: "FAILED", error: expect.stringContaining("the attachment receipt.pdf isn't the file approved") as unknown });
      expect(sent).toHaveLength(1);
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

    it("examples/apps/tasks.yaml: /task Renew the passport adds an open task", async () => {
      const appId = await runCommand("task-from-telegram.yaml", "apps/tasks.yaml", command("task", "Renew the passport\nbefore the trip"));
      expect(await only(appId, "Task")).toMatchObject({ title: "Renew the passport", id: expect.stringMatching(/^[a-z0-9]{12}$/) as unknown });
      expect(telegram.calls.map((c) => c.text)).toEqual(["Added: Renew the passport"]);
    });

    it("examples/apps/tasks.yaml: /task with #tags: tagged, the title without them, a tag once (M65-T8)", async () => {
      const appId = await runCommand("task-from-telegram.yaml", "apps/tasks.yaml", command("task", "Buy milk #errands #Home, #home"));
      expect(await only(appId, "Task")).toMatchObject({ title: "Buy milk", tag: ["errands", "Home"] });
    });

    it("examples/apps/memos.yaml: a photo with /memo kept with its text; the photo downloaded from the bot", async () => {
      const appId = await runCommand("memo-from-telegram.yaml", "apps/memos.yaml", command("memo", "Wi-Fi at the cottage", sentPhoto));
      const memo = await only(appId, "Memo");
      expect(memo).toMatchObject({ title: "Wi-Fi at the cottage", text: "Wi-Fi at the cottage", photo: { name: "photo-1763109000.jpg", mime: "image/jpeg", size: photo.length } });
      expect(downloads).toEqual(["https://api.telegram.org/bot<token>/getFile", "https://api.telegram.org/file/bot<token>/photos/file_7.jpg"]);
      expect(telegram.calls.map((c) => c.text)).toEqual(["Kept: Wi-Fi at the cottage"]);
    });

    it("examples/apps/memos.yaml: /memo with #tags, on any line: tagged, the title without them (M65-T7)", async () => {
      const appId = await runCommand("memo-from-telegram.yaml", "apps/memos.yaml", command("memo", "Gate code #cottage\n4711, ask at the #вила"));
      expect(await only(appId, "Memo")).toMatchObject({ title: "Gate code", text: "Gate code #cottage\n4711, ask at the #вила", tags: ["cottage", "вила"] });
    });

    it("examples/apps/memos.yaml: /memo with only a #tag: the title as written", async () => {
      const appId = await runCommand("memo-from-telegram.yaml", "apps/memos.yaml", command("memo", "#idea"));
      expect(await only(appId, "Memo")).toMatchObject({ title: "#idea", tags: ["idea"] });
    });

    it("examples/apps/papers.yaml: a photo with /paper becomes a paper with its document", async () => {
      const appId = await runCommand("paper-from-telegram.yaml", "apps/papers.yaml", command("paper", "Washing machine", sentPhoto));
      expect(await only(appId, "Paper")).toMatchObject({ title: "Washing machine", document: { mime: "image/jpeg" } });
      expect(telegram.calls.map((c) => c.text)).toEqual(["Kept: Washing machine. Reading it now."]);
    });

    it("examples/apps/papers.yaml: /paper without a photo or file keeps nothing and says why", async () => {
      const { appId, definition } = await install("apps/papers.yaml");
      const versionId = await createVersion(db.client, userId, read("paper-from-telegram.yaml"), compiler, { app: definition });
      const runId = await runner.start(versionId, { trigger: "telegram", triggerData: command("paper", "Washing machine") });
      expect(await runner.advance(runId)).toBe("DONE");
      expect(await db.client.dataEntity.count({ where: { appId, type: "Paper" } })).toBe(0);
      expect(telegram.calls.map((c) => c.text)).toEqual([expect.stringContaining("Nothing kept: /paper needs a photo or a PDF") as unknown]);
    });
  });
});

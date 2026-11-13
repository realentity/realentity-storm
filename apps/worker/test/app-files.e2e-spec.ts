import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { emptyUsage, ModelRouter, type LlmClient, type LlmFile, type LlmUsage, type StructuredRequest } from "@realentity/storm-llm";
import { type EmailMessage } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { type z } from "zod";
import { ArtifactStore } from "../src/browser/artifact-store";
import { type MailAttachment, type MailConnector } from "../src/mail/mail-connector";
import { NO_ATTENTION, type StepContext } from "../src/runner/step-executor";
import { AppFileStore, FileKeepStep } from "../src/steps/app-file-steps";
import { SaveStep } from "../src/steps/data-steps";
import { FileReadStep } from "../src/steps/file-steps";
import { ExtractStep } from "../src/steps/llm-steps";
import { pdfWithText } from "./support/pdf";

jest.setTimeout(60_000);

const PAPERS = `
name: Papers
types:
  Paper:
    key: title
    fields:
      title: { type: text, required: true }
      merchant: { type: text }
      scan: { type: image }
      receipt: { type: file }
pages:
  - list: Paper
    add: true
`;

/** Reads what it is shown: answers with the names of the files it saw. */
class Looker implements LlmClient {
  seen: LlmFile[][] = [];
  structured<S extends z.ZodObject>(request: StructuredRequest<S>): Promise<{ output: z.infer<S>; usage: LlmUsage }> {
    this.seen.push(request.files ?? []);
    const answer = { values: [{ name: "merchant", value: (request.files ?? []).map((f) => f.name).join(" + ") }] };
    return Promise.resolve({ output: request.schema.parse(answer), usage: { ...emptyUsage(), calls: 1 } });
  }
}

// M46-T3, T4 (I2): a pipeline keeps an email's attachments into an entity, reads them back, shows the model its images
describe("an App's files in pipelines", () => {
  let db: PrismaConnection;
  let userId: string;
  let appId: string;
  let root: string;
  let artifactsDir: string;
  let store: AppFileStore;
  let photo: Buffer;
  let pdf: Buffer;
  let attachments: MailAttachment[];
  const mail = {
    attachments: () => Promise.resolve(attachments),
  } as unknown as MailConnector;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    root = await mkdtemp(join(tmpdir(), "storm-worker-app-files-"));
    artifactsDir = await mkdtemp(join(tmpdir(), "storm-worker-artifacts-"));
    store = new AppFileStore(root);
    photo = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 200, g: 60, b: 60 } } }).jpeg().toBuffer();
    pdf = pdfWithText("Northwind Appliances, receipt 1042, total 499.00 EUR");
  });

  beforeEach(async () => {
    const app = await db.client.app.create({ data: { userId, name: "Papers" } });
    const version = await db.client.appVersion.create({ data: { appId: app.appId, version: 1, definition: {}, source: PAPERS } });
    await db.client.app.update({ where: { appId: app.appId }, data: { currentVersionId: version.appVersionId } });
    appId = app.appId;
  });

  afterEach(async () => {
    await db.client.artifact.deleteMany();
    await db.client.app.deleteMany();
  });

  afterAll(async () => {
    await db.close();
    await rm(root, { recursive: true, force: true });
    await rm(artifactsDir, { recursive: true, force: true });
  });

  const context = (dryRun = false, app = "Papers"): StepContext => ({
    runId: randomUUID(),
    userId,
    pipelineId: randomUUID(),
    stepId: "s",
    stepKey: "keep",
    itemIndex: null,
    dryRun,
    app,
    recordUsage: () => undefined,
    attention: NO_ATTENTION,
  });
  const message = (names: string[]): EmailMessage => ({
    uid: 7,
    messageId: "<receipt@shop.example>",
    threadId: "<receipt@shop.example>",
    inReplyTo: null,
    references: [],
    from: "orders@shop.example",
    fromName: "Northwind",
    replyTo: "orders@shop.example",
    to: ["me@example.org"],
    cc: [],
    subject: "Your receipt",
    date: "2026-11-13T10:00:00Z",
    text: "Thanks for your order.",
    attachments: names.map((filename) => ({ filename, contentType: "application/octet-stream", size: 1 })),
  });
  const keep = (field: string, input: Record<string, unknown>, dryRun = false) =>
    new FileKeepStep(db.client, store, mail, new ArtifactStore(artifactsDir)).execute({ type: "Paper", field, mailbox: "INBOX", max: 5, ...input }, context(dryRun)) as Promise<{
      files: { id: string; name: string; mime: string }[];
      first: { id: string; name: string } | null;
      found: number;
      skipped: { name: string; reason: string }[];
    }>;
  const save = (items: unknown[]) =>
    new SaveStep(db.client, root).execute({ type: "Paper", items, complete: false }, context()) as Promise<{ invalid: { key: string; problems: string[] }[] }>;
  const paper = (title: string) => db.client.dataEntity.findUniqueOrThrow({ where: { appId_type_key: { appId, type: "Paper", key: title } } });
  const stored = async () => (await readdir(join(root, "app-files")).catch(() => [])).filter((f) => !f.endsWith(".thumb.webp")).length;

  it("keeps an email's attachments by content, attaches them on save, keeps them on a save without them, and releases a replaced one", async () => {
    attachments = [
      { filename: "receipt.pdf", contentType: "application/pdf", content: pdf },
      { filename: "photo.jpg", contentType: "image/jpeg", content: photo },
      { filename: "terms.html", contentType: "text/html", content: Buffer.from("<html><script>x()</script></html>") },
    ];
    // An image field takes only the image; a file field the PDF and the image, never the HTML.
    const dry = await keep("scan", { message: message(["receipt.pdf", "photo.jpg", "terms.html"]) }, true);
    expect(dry).toMatchObject({ files: [], found: 1 });
    expect(await stored()).toBe(0);
    const scans = await keep("scan", { message: message(["receipt.pdf", "photo.jpg", "terms.html"]) });
    expect(scans.files.map((f) => f.name)).toEqual(["photo.jpg"]);
    expect(scans.skipped.map((s) => s.name)).toEqual(["receipt.pdf", "terms.html"]);
    const receipts = await keep("receipt", { message: message(["receipt.pdf", "photo.jpg", "terms.html"]), max: 1 });
    expect(receipts.files).toMatchObject([{ name: "receipt.pdf", mime: "application/pdf" }]);
    expect(receipts.skipped.map((s) => s.reason)).toEqual(["more than 1", "more than 1"]);

    // data.save attaches them; another entity can't take the same file, nor a field another field's.
    const result = await save([
      { title: "Washing machine", scan: scans.first, receipt: receipts.first },
      { title: "Oven", scan: scans.first, receipt: scans.first },
    ]);
    expect(result.invalid).toEqual([
      { key: "Oven", saved: true, problems: ["scan isn't a file file.keep kept for Paper.scan"] },
      { key: "Oven", saved: true, problems: ["receipt isn't a file file.keep kept for Paper.receipt"] },
    ]);
    expect((await paper("Washing machine")).value).toEqual({ title: "Washing machine", scan: scans.files[0], receipt: receipts.files[0] });
    expect((await paper("Oven")).value).toEqual({ title: "Oven" });

    // A re-read without the files keeps them; a new scan replaces the old one, which goes.
    await save([{ title: "Washing machine", merchant: "Northwind Appliances" }]);
    expect((await paper("Washing machine")).value).toEqual({ title: "Washing machine", merchant: "Northwind Appliances", scan: scans.files[0], receipt: receipts.files[0] });
    attachments = [{ filename: "photo-2.jpg", contentType: "image/jpeg", content: photo }];
    const newer = await keep("scan", { message: message(["photo-2.jpg"]) });
    await save([{ title: "Washing machine", scan: newer.first }]);
    expect(((await paper("Washing machine")).value as { scan: { id: string } }).scan.id).toBe(newer.first!.id);
    expect(await db.client.appFile.findUnique({ where: { appFileId: scans.files[0].id } })).toBeNull();
    expect(await stored()).toBe(2);
  });

  it("keeps a download; reads an entity's PDF and shows the model its image, only of the pipeline's own App", async () => {
    await mkdir(join(artifactsDir, "run"), { recursive: true });
    await writeFile(join(artifactsDir, "run", "invoice.pdf"), pdf);
    const artifact = await db.client.artifact.create({ data: { userId, kind: "download", path: "run/invoice.pdf", mime: "application/pdf", size: pdf.length, sha256: "x" } });
    const kept = await keep("receipt", { artifact: artifact.artifactId });
    attachments = [{ filename: "photo.jpg", contentType: "image/jpeg", content: photo }];
    const scan = await keep("scan", { message: message(["photo.jpg"]) });
    await save([{ title: "Washing machine", receipt: kept.first, scan: scan.first }]);
    const item = (await paper("Washing machine")).value as { receipt: unknown; scan: unknown };

    const read = (await new FileReadStep(db.client, undefined, undefined, store).execute({ file: item.receipt, maxChars: 1000 }, context())) as { text: string; filename: string };
    expect(read).toMatchObject({ filename: "invoice.pdf" });
    expect(read.text).toContain("receipt 1042");
    await expect(new FileReadStep(db.client, undefined, undefined, store).execute({ file: item.scan, maxChars: 1000 }, context())).rejects.toThrow(
      "photo.jpg is an image: llm.extract's files reads what it shows",
    );

    const looker = new Looker();
    const extract = new ExtractStep(looker, new ModelRouter(() => Promise.resolve(null))).withFiles(db.client, store);
    const answer = (await extract.execute({ files: [item.scan, null, item.receipt], fields: { merchant: "the shop" }, timeZone: "Europe/Sofia" }, context())) as {
      values: Record<string, string>;
    };
    expect(answer.values.merchant).toBe("photo.jpg + invoice.pdf");
    const [image, document] = looker.seen[0];
    expect(image.mime).toBe("image/jpeg");
    expect(await sharp(image.data).metadata()).toMatchObject({ width: 1568 });
    expect(document).toMatchObject({ name: "invoice.pdf", mime: "application/pdf" });

    // Another App's pipeline can't read them; nor can a made-up id.
    const other = await db.client.app.create({ data: { userId, name: "Other" } });
    await expect(extract.execute({ files: [item.scan], fields: { merchant: "the shop" }, timeZone: "Europe/Sofia" }, { ...context(false, "Other"), appId: other.appId })).rejects.toThrow(
      /No file .* in this pipeline's App/,
    );
    await expect(new FileReadStep(db.client, undefined, undefined, store).execute({ file: { id: randomUUID() }, maxChars: 1000 }, context())).rejects.toThrow(/No file/);
  });
});

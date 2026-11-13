import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { type AppDetailView, type AppEntityView, type FileRef } from "@realentity/storm-shared";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

const PAPERS = `
name: Papers
types:
  Paper:
    key: title
    fields:
      title: { type: text, required: true }
      scan: { type: image }
      receipt: { type: file }
pages:
  - list: Paper
    add: true
  - form: Paper
    fields: [scan, receipt]
`;

const PDF = Buffer.from("%PDF-1.4\n% a receipt\n%%EOF\n");

// M46-I1, S1: files and images on an App's forms
describe("an App's files and images", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;
  let documentsDir: string;
  let appId: string;
  let photo: Buffer;

  beforeAll(async () => {
    documentsDir = await mkdtemp(join(tmpdir(), "storm-api-app-files-"));
    process.env.DOCUMENTS_DIR = documentsDir;
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
    photo = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 200, g: 120, b: 40 } } }).jpeg().toBuffer();
  });

  beforeEach(async () => {
    appId = ((await agent.post("/api/apps").send({ source: PAPERS }).expect(201)).body as AppDetailView).appId;
  });

  afterEach(async () => {
    await db.client.app.deleteMany();
  });

  afterAll(async () => {
    await db.close();
    await api.close();
    delete process.env.DOCUMENTS_DIR;
    await rm(documentsDir, { recursive: true, force: true });
  });

  const upload = (field: string, content: Buffer, filename: string) =>
    agent.post(`/api/apps/${appId}/files`).field("type", "Paper").field("field", field).attach("file", content, filename);
  const paper = (title: string) => `/api/apps/${appId}/pages/Paper/${encodeURIComponent(title)}`;
  const stored = async () => (await readdir(join(documentsDir, "app-files")).catch(() => [])).sort();

  it("uploads on the form, attaches on save, shows an image with a thumbnail, and removes a file replaced, cleared or deleted with its entity", async () => {
    const scan = (await upload("scan", photo, "warranty.jpg").expect(201)).body as FileRef;
    expect(scan).toMatchObject({ name: "warranty.jpg", mime: "image/jpeg", size: photo.length });
    const receipt = (await upload("receipt", PDF, "receipt.pdf").expect(201)).body as FileRef;

    const added = (
      await agent
        .post(`/api/apps/${appId}/pages/Paper`)
        .send({ values: { title: "Washing machine", scan: scan.id, receipt: receipt.id } })
        .expect(201)
    ).body as AppEntityView;
    expect(added.row.value).toEqual({ title: "Washing machine", scan, receipt });

    // The image is shown, never sniffed or run; its thumbnail is a small WebP; another file is a download.
    const image = await agent.get(`/api/app-files/${scan.id}`).buffer(true).expect(200);
    expect(Buffer.from(image.body as Buffer).equals(photo)).toBe(true);
    expect(image.headers).toMatchObject({ "content-type": "image/jpeg", "content-security-policy": "sandbox", "x-content-type-options": "nosniff" });
    expect(image.headers["content-disposition"]).toBe('inline; filename="warranty.jpg"');
    const thumb = await agent.get(`/api/app-files/${scan.id}/thumb`).buffer(true).expect(200);
    expect(thumb.headers["content-type"]).toBe("image/webp");
    expect(await sharp(thumb.body as Buffer).metadata()).toMatchObject({ format: "webp", width: 480, height: 320 });
    const pdf = await agent.get(`/api/app-files/${receipt.id}`).buffer(true).expect(200);
    expect(pdf.headers["content-disposition"]).toBe('attachment; filename="receipt.pdf"');
    await agent.get(`/api/app-files/${receipt.id}/thumb`).expect(404);

    // Replaced on the form: the old image goes; cleared: the receipt goes.
    const newer = (await upload("scan", photo, "warranty-back.jpg").expect(201)).body as FileRef;
    const edited = (await agent.put(`${paper("Washing machine")}/values`).send({ values: { scan: newer.id, receipt: null } }).expect(200)).body as AppEntityView;
    expect(edited.row.value).toEqual({ title: "Washing machine", scan: newer });
    await agent.get(`/api/app-files/${scan.id}`).expect(404);
    await agent.get(`/api/app-files/${receipt.id}`).expect(404);
    expect(await stored()).toEqual([`${newer.id}.jpg`, `${newer.id}.thumb.webp`]);

    // Deleted with its entity.
    await agent.delete(paper("Washing machine")).expect(204);
    await agent.get(`/api/app-files/${newer.id}`).expect(404);
    expect(await stored()).toEqual([]);
  });

  it("takes a file by its content, only into its own field and entity; an upload never saved goes after a day", async () => {
    await upload("scan", PDF, "scan.pdf").expect(400);
    await upload("scan", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "scan.svg").expect(400);
    await upload("receipt", Buffer.from("MZ\x90\x00binary"), "receipt.exe").expect(400);
    await upload("receipt", Buffer.from([0x68, 0x69, 0x00, 0xff]), "receipt.txt").expect(400);
    await upload("title", PDF, "receipt.pdf").expect(400);
    await agent.post(`/api/apps/${appId}/files`).field("type", "Nope").field("field", "scan").attach("file", photo, "a.jpg").expect(400);

    // A file of one field isn't another's, nor one entity's another's.
    const scan = (await upload("scan", photo, "a.jpg").expect(201)).body as FileRef;
    await agent.post(`/api/apps/${appId}/pages/Paper`).send({ values: { title: "Oven", receipt: scan.id } }).expect(400);
    await agent.post(`/api/apps/${appId}/pages/Paper`).send({ values: { title: "Oven", scan: scan.id } }).expect(201);
    await agent.post(`/api/apps/${appId}/pages/Paper`).send({ values: { title: "Fridge", scan: scan.id } }).expect(400);
    await agent.post(`/api/apps/${appId}/pages/Paper`).send({ values: { title: "Kettle", scan: "1b671a64-40d5-491e-99b0-da01e8a64ba1" } }).expect(400);

    const unsaved = (await upload("scan", photo, "b.jpg").expect(201)).body as FileRef;
    await db.client.appFile.update({ where: { appFileId: unsaved.id }, data: { dateCreated: new Date(Date.now() - 25 * 3_600_000) } });
    await upload("receipt", PDF, "c.pdf").expect(201);
    await agent.get(`/api/app-files/${unsaved.id}`).expect(404);
    await agent.get(`/api/app-files/${scan.id}`).expect(200);

    // The App deleted: its files with it.
    await agent.delete(`/api/apps/${appId}`).expect(204);
    expect(await stored()).toEqual([]);
  });
});

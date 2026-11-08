import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { type DocumentView, type SettingsView } from "@realentity/storm-shared";
import { TestEnvironment } from "@realentity/storm-testing";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

const PDF = Buffer.from("%PDF-1.4\n% my CV\n%%EOF\n");

// M10: my documents (what forms may attach) and my profile (what forms are filled from)
describe("documents and profile", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;
  let userId: string;
  let documentsDir: string;

  beforeAll(async () => {
    documentsDir = await mkdtemp(join(tmpdir(), "storm-api-documents-"));
    process.env.DOCUMENTS_DIR = documentsDir;
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  afterEach(async () => {
    await db.client.document.deleteMany();
    await db.client.userSetting.deleteMany();
  });

  afterAll(async () => {
    await db.close();
    await api.close();
    delete process.env.DOCUMENTS_DIR;
    await rm(documentsDir, { recursive: true, force: true });
  });

  const upload = (name: string, content: Buffer, filename: string) =>
    agent.post("/api/documents").field("name", name).attach("file", content, filename);

  it("stores a document by its content, replaces it by name and keeps the old file for what was approved with it", async () => {
    const first = (await upload("cv-main", PDF, "Ana Petrova CV.pdf").expect(201)).body as DocumentView;
    expect(first).toMatchObject({ name: "cv-main", filename: "Ana Petrova CV.pdf", mime: "application/pdf", size: PDF.length });
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);

    const newer = Buffer.from("%PDF-1.4\n% my CV, 2026\n%%EOF\n");
    const second = (await upload("cv-main", newer, "Ana Petrova CV 2026.pdf").expect(201)).body as DocumentView;
    expect(((await agent.get("/api/documents").expect(200)).body as DocumentView[]).map((d) => d.documentId)).toEqual([second.documentId]);
    expect(await db.client.document.findUniqueOrThrow({ where: { documentId: first.documentId } })).toMatchObject({ replacedAt: expect.any(Date) as unknown });

    // Both stay downloadable, always as attachments, never to open in this origin.
    const file = await agent.get(`/api/documents/${first.documentId}/file`).buffer(true).expect(200);
    expect(Buffer.from(file.body as Buffer).equals(PDF)).toBe(true);
    expect(file.headers["content-security-policy"]).toBe("sandbox");
    expect(file.headers["content-disposition"]).toBe('attachment; filename="Ana_Petrova_CV.pdf"');

    // Removing hides it from forms; the files stay.
    await agent.delete("/api/documents/cv-main").expect(204);
    expect((await agent.get("/api/documents").expect(200)).body).toEqual([]);
    expect(await readdir(documentsDir)).toHaveLength(2);
    await agent.get(`/api/documents/${second.documentId}/file`).expect(200);
    await agent.delete("/api/documents/cv-main").expect(404);
  });

  it("refuses what isn't a PDF, DOCX or ODT by content, a bad name, or no file", async () => {
    expect((await upload("cv-main", Buffer.from("MZ\x90\x00 not a pdf", "latin1"), "cv.pdf").expect(400)).body).toMatchObject({
      message: "Its content isn't a .pdf file",
    });
    await upload("cv-main", Buffer.from("MZ\x90\x00", "latin1"), "setup.exe").expect(400);
    await upload("CV Main", PDF, "cv.pdf").expect(400);
    await agent.post("/api/documents").field("name", "cv-main").expect(400);
    expect(await db.client.document.count()).toBe(0);
  });

  it("other people's documents are not mine", async () => {
    const other = await db.client.user.create({ data: { email: `other-${Date.now()}@storm.test` } });
    try {
      const theirs = await db.client.document.create({
        data: { userId: other.userId, name: "cv-main", filename: "x.pdf", mime: "application/pdf", size: 1, sha256: "0".repeat(64), path: "x.pdf" },
      });
      expect((await agent.get("/api/documents").expect(200)).body).toEqual([]);
      await agent.get(`/api/documents/${theirs.documentId}/file`).expect(404);
    } finally {
      await db.client.user.delete({ where: { userId: other.userId } });
    }
  });

  it("keeps my profile for application forms; empty clears it", async () => {
    expect(((await agent.get("/api/settings").expect(200)).body as SettingsView).profile).toBe("");
    const profile = "Ana Petrova · ana@storm.test · Sofia · notice period: 1 month";
    expect(((await agent.put("/api/settings").send({ profile }).expect(200)).body as SettingsView).profile).toBe(profile);
    expect((await db.client.userSetting.findUniqueOrThrow({ where: { userId } })).profile).toBe(profile);
    expect(((await agent.put("/api/settings").send({ profile: "  " }).expect(200)).body as SettingsView).profile).toBe("");
  });
});

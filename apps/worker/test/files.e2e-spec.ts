import { payloadHash, KeyRing } from "@ai-me/crypto";
import { createPrismaConnection, type Prisma, type PrismaConnection } from "@ai-me/db";
import { defaultCatalog } from "@ai-me/steps";
import { TestEnvironment } from "@ai-me/testing";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/browser/artifact-store";
import { BrowserPool } from "../src/browser/browser-pool";
import { DocumentStore } from "../src/browser/document-store";
import { SessionStore } from "../src/browser/session-store";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { RunControls } from "../src/runner/run-controls";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { TakeoverDesk } from "../src/runner/takeovers";
import { CredentialVault } from "../src/secrets/credential-vault";
import { BrowserDownloadStep, BrowserUploadStep, FileReadStep } from "../src/steps/file-steps";
import { startFixtureSites, type FixtureSites } from "./support/fixture-sites";
import { createVersion } from "./support/test-steps";

jest.setTimeout(60_000);

/** A one-page PDF whose text layer says `text` (offsets computed, so a real parser reads it). */
function pdfWithText(text: string): Buffer {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const CV = pdfWithText("Ana Petrova - senior .NET engineer");

// M11-T5: downloads through the quarantine, reading files, and an upload behind its gate (no real site)
describe("file steps", () => {
  let db: PrismaConnection;
  let userId: string;
  let sites: FixtureSites;
  let artifactsDir: string;
  let documentsDir: string;
  let pool: BrowserPool;
  let runner: PipelineRunner;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    sites = await startFixtureSites();
    artifactsDir = await mkdtemp(join(tmpdir(), "aime-artifacts-"));
    documentsDir = await mkdtemp(join(tmpdir(), "aime-documents-"));
    pool = new BrowserPool({ invisible: true });
    const keys = KeyRing.fromEnv(process.env);
    const vault = new CredentialVault(db.client, keys);
    const artifacts = new ArtifactStore(artifactsDir);
    const documents = new DocumentStore(documentsDir);
    const deps = { prisma: db.client, pool, sessions: new SessionStore(db.client, keys, vault), vault, artifacts, documents };
    const executors = new ExecutorRegistry([
      new BrowserDownloadStep(deps, 1),
      new BrowserUploadStep(deps),
      new FileReadStep(db.client, artifacts, documents),
    ]);
    const desk = new TakeoverDesk(db.client, () => Promise.resolve(), { timeoutMs: 10_000, pollMs: 100 });
    runner = new PipelineRunner(db.client, defaultCatalog(), executors, new RunControls(db.client), undefined, desk);
  });

  beforeEach(async () => {
    const row = await db.client.document.create({
      data: { userId, name: "cv-main", filename: "Ana Petrova CV.pdf", mime: "application/pdf", size: CV.length, sha256: sha(CV), path: "pending" },
    });
    await writeFile(join(documentsDir, `${row.documentId}.pdf`), CV);
    await db.client.document.update({ where: { documentId: row.documentId }, data: { path: `${row.documentId}.pdf` } });
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.artifact.deleteMany();
    await db.client.document.deleteMany();
    sites.reset();
  });

  afterAll(async () => {
    await pool.close();
    await sites.stop();
    await rm(artifactsDir, { recursive: true, force: true });
    await rm(documentsDir, { recursive: true, force: true });
    await db.close();
  });

  const sha = (content: Buffer) => createHash("sha256").update(content).digest("hex");
  const run = async (source: string) => {
    const runId = await runner.start(await createVersion(db.client, userId, source), { trigger: "manual" });
    return { runId, status: await runner.advance(runId) };
  };
  const step = (runId: string, stepKey: string) => db.client.step.findFirstOrThrow({ where: { runId, stepKey } });

  it("browser.download keeps an allowed file (the address, or what a click downloads) and file.read gives its text", async () => {
    const { runId, status } = await run(`name: Notes
steps:
  - id: direct
    type: browser.download
    with: { url: "${sites.url("app", "/files/notes.txt")}" }
  - id: clicked
    type: browser.download
    with: { url: "${sites.url("app", "/downloads")}", click: 'a[href="/files/report.pdf"]' }
  - id: read
    type: file.read
    with: { artifact: "{{direct.artifactId}}" }
`);
    expect(status).toBe("DONE");
    expect((await step(runId, "direct")).output).toMatchObject({ filename: "notes.txt", mime: "text/plain", size: 40 });
    expect((await step(runId, "clicked")).output).toMatchObject({ filename: "report.pdf", mime: "application/pdf" });
    expect((await step(runId, "read")).output).toMatchObject({ text: "Interview on Tuesday — бележки", truncated: false, documentId: null });
  });

  it("a download whose content isn't what its name says is deleted, and the step fails saying so", async () => {
    const { runId, status } = await run(`name: Disguised
steps:
  - id: get
    type: browser.download
    with: { url: "${sites.url("app", "/files/invoice.pdf")}" }
`);
    expect(status).toBe("FAILED");
    expect((await step(runId, "get")).error).toBe("The download invoice.pdf was deleted: its content isn't a .pdf file");
    expect(await db.client.artifact.count({ where: { runId, kind: "download" } })).toBe(0);
  });

  it("M11-T5: browser.upload sends my approved document only after Act, and file.read reads a PDF's text", async () => {
    const source = `name: Upload CV
policy: { allowedDomains: [ats.localhost] }
steps:
  - id: cv
    type: file.read
    with: { document: cv-main }
  - id: upload
    type: browser.upload
    with: { url: "${sites.url("ats", "/quick-apply")}", field: "#resume", file: "{{cv}}" }
`;
    const { runId, status } = await run(source);
    expect(status).toBe("WAITING_FOR_USER");
    expect((await step(runId, "cv")).output).toMatchObject({ text: "Ana Petrova - senior .NET engineer", document: "cv-main", sha256: sha(CV) });
    const uploads = () => sites.posts.filter((p) => p.host === "ats.localhost" && p.path === "/uploads");
    expect(uploads()).toEqual([]);

    const proposal = await db.client.proposal.findFirstOrThrow({ where: { runId } });
    const payload = proposal.originalPayload as Record<string, unknown>;
    expect(payload.file).toMatchObject({ document: "cv-main", filename: "Ana Petrova CV.pdf", sha256: sha(CV) });
    await db.client.proposal.update({
      where: { proposalId: proposal.proposalId },
      data: { status: "APPROVED", finalPayload: payload as Prisma.InputJsonValue, payloadHash: payloadHash(payload) },
    });
    expect(await runner.advance(runId)).toBe("DONE");
    for (let i = 0; i < 100 && uploads().length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(uploads()).toHaveLength(1);
    expect(uploads()[0].body).toContain('filename="Ana Petrova CV.pdf"');
  });
});

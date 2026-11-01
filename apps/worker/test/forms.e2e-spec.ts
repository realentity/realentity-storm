import { payloadHash, KeyRing } from "@ai-me/crypto";
import { createPrismaConnection, type Prisma, type PrismaConnection, type Proposal } from "@ai-me/db";
import { emptyUsage, ModelRouter, type LlmClient, type StructuredRequest } from "@ai-me/llm";
import { defaultCatalog, type FormField, type FormFile } from "@ai-me/steps";
import { TestEnvironment } from "@ai-me/testing";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type z } from "zod";
import { ArtifactStore } from "../src/browser/artifact-store";
import { BrowserPool } from "../src/browser/browser-pool";
import { DocumentStore } from "../src/browser/document-store";
import { SessionStore } from "../src/browser/session-store";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { RunControls } from "../src/runner/run-controls";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { TakeoverDesk } from "../src/runner/takeovers";
import { CredentialVault } from "../src/secrets/credential-vault";
import { FillAndSubmitStep, MapFormStep } from "../src/steps/form-steps";
import { startFixtureSites, type FixtureSites } from "./support/fixture-sites";
import { createVersion } from "./support/test-steps";

jest.setTimeout(60_000);

const PROFILE = "Ana Petrova · ana@aime.test · +359 88 123 4567 · Sofia · EU citizen · notice period: 1 month";
const CV = Buffer.from("%PDF-1.4\n% Ana Petrova CV fixture\n%%EOF\n");

/** The mapForm model: values by field key, as a real one would read them from the profile; records the prompts. */
class FormLlm implements LlmClient {
  prompts: string[] = [];
  structured<S extends z.ZodObject>(request: StructuredRequest<S>) {
    this.prompts.push(request.prompt);
    const answers: Record<string, [string | null, string]> = {
      "#name": ["Ana Petrova", "profile"],
      "#email": ["ana@aime.test", "profile"],
      "#phone": ["+359 88 123 4567", "profile"],
      "#notice": ["1 month", "profile"],
      "#message": ["I build .NET backends in Sofia and would like to do it at Acme.", "written"],
      '[name="consent"]': ["yes", "profile"],
      '[name="newsletter"]': ["no", "none"],
      "#qname": ["Ana Petrova", "profile"],
      '[name="your-name"]': ["Ana Petrova", "profile"],
      '[name="your-email"]': ["ana@aime.test", "profile"],
      '[name="your-message"]': ["I build .NET backends in Sofia.", "written"],
      '[name="privacy\\[\\]"]': ["yes", "profile"],
    };
    const keys = [...request.prompt.matchAll(/\{"key":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);
    const values = keys.map((key) => ({ key, value: answers[key]?.[0] ?? null, source: answers[key]?.[1] ?? "none" }));
    return Promise.resolve({ output: request.schema.parse({ values, notes: "" }), usage: { ...emptyUsage(), calls: 1, costUsd: 0.01 } });
  }
}

// M10: map → gate → act on application forms, against the local ATS (no real site)
describe("application forms", () => {
  let db: PrismaConnection;
  let userId: string;
  let sites: FixtureSites;
  let artifactsDir: string;
  let documentsDir: string;
  let pool: BrowserPool;
  let runner: PipelineRunner;
  const llm = new FormLlm();

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    sites = await startFixtureSites();
    artifactsDir = await mkdtemp(join(tmpdir(), "aime-artifacts-"));
    documentsDir = await mkdtemp(join(tmpdir(), "aime-documents-"));
    pool = new BrowserPool({ invisible: true });
    const keys = KeyRing.fromEnv(process.env);
    const vault = new CredentialVault(db.client, keys);
    const deps = {
      prisma: db.client,
      pool,
      sessions: new SessionStore(db.client, keys, vault),
      vault,
      artifacts: new ArtifactStore(artifactsDir),
      documents: new DocumentStore(documentsDir),
    };
    const executors = new ExecutorRegistry([new MapFormStep(deps, llm, new ModelRouter(() => Promise.resolve(null))), new FillAndSubmitStep(deps)]);
    const desk = new TakeoverDesk(db.client, () => Promise.resolve(), { timeoutMs: 10_000, pollMs: 100 });
    runner = new PipelineRunner(db.client, defaultCatalog(), executors, new RunControls(db.client), undefined, desk);
  });

  beforeEach(async () => {
    await db.client.userSetting.upsert({ where: { userId }, create: { userId, profile: PROFILE }, update: { profile: PROFILE } });
    await document("cv-main", "Ana Petrova CV.pdf", CV);
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.application.deleteMany();
    await db.client.jobPosting.deleteMany();
    await db.client.document.deleteMany();
    await db.client.userSetting.deleteMany();
    llm.prompts.length = 0;
    sites.reset();
  });

  afterAll(async () => {
    await pool.close();
    await sites.stop();
    await rm(artifactsDir, { recursive: true, force: true });
    await rm(documentsDir, { recursive: true, force: true });
    await db.close();
  });

  /** As the api stores an upload: the file under DOCUMENTS_DIR, its row with the SHA-256; an older one replaced. */
  async function document(name: string, filename: string, content: Buffer) {
    await db.client.document.updateMany({ where: { userId, name, replacedAt: null }, data: { replacedAt: new Date() } });
    const row = await db.client.document.create({
      data: { userId, name, filename, mime: "application/pdf", size: content.length, sha256: sha(content), path: `pending-${Date.now()}` },
    });
    await writeFile(join(documentsDir, `${row.documentId}.pdf`), content);
    return db.client.document.update({ where: { documentId: row.documentId }, data: { path: `${row.documentId}.pdf` } });
  }
  const sha = (content: Buffer) => createHash("sha256").update(content).digest("hex");

  const postingUrl = () => sites.url("ats", "/jobs/7");
  const APPLY = (extra = "", policy = "ats.localhost") => `name: Apply
policy: { allowedDomains: [${policy}] }
steps:
  - id: map
    type: browser.mapForm
    with:
      url: "${postingUrl()}"
      cv: cv-main
      job: { url: "${postingUrl()}", title: Senior .NET Developer, company: Acme }
  - id: apply
    type: browser.fillAndSubmit
    with:
      url: "{{map.formUrl}}"
      fields: "{{map.fields}}"
      files: "{{map.files}}"
      job: "${postingUrl()}"
${extra}`;

  /** Runs to the gate; the proposal of the apply step. */
  async function toGate(source: string): Promise<{ runId: string; proposal: Proposal }> {
    await db.client.jobPosting.upsert({
      where: { userId_url: { userId, url: postingUrl() } },
      create: { userId, source: "ats", url: postingUrl(), title: "Senior .NET Developer", company: "Acme" },
      update: {},
    });
    const runId = await runner.start(await createVersion(db.client, userId, source), { trigger: "manual" });
    expect(await runner.advance(runId)).toBe("WAITING_FOR_USER");
    return { runId, proposal: await db.client.proposal.findFirstOrThrow({ where: { runId } }) };
  }

  /** What the api does on Act: the final payload, its hash, approved new targets. */
  async function approve(proposal: Proposal, edit = (p: Record<string, unknown>) => p, approvedNewTargets: string[] = []) {
    const finalPayload = edit(structuredClone(proposal.originalPayload as Record<string, unknown>));
    await db.client.proposal.update({
      where: { proposalId: proposal.proposalId },
      data: { status: "APPROVED", finalPayload: finalPayload as Prisma.InputJsonValue, payloadHash: payloadHash(finalPayload), approvedNewTargets },
    });
  }

  const until = async <T>(read: () => Promise<T | null | undefined>, what: string): Promise<T> => {
    for (let i = 0; i < 200; i++) {
      const value = await read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${what}`);
  };
  const posted = () => sites.posts.filter((p) => p.host === "ats.localhost");
  const applyStep = (runId: string) => db.client.step.findFirstOrThrow({ where: { runId, stepKey: "apply" } });

  it("M10-T2: maps the wizard behind Apply from my profile, attaches my CV, and types or sends nothing", async () => {
    const { runId, proposal } = await toGate(APPLY());
    const payload = proposal.originalPayload as { url: string; fields: FormField[]; files: FormFile[] };
    expect(payload.url).toBe(sites.url("ats", "/apply/7"));
    const byKey = Object.fromEntries(payload.fields.map((f) => [f.key, f]));
    expect(Object.keys(byKey)).toEqual(["#name", "#email", "#phone", "#cv", "#letter", "#notice", "#message", '[name="consent"]', '[name="newsletter"]']);
    expect(byKey["#name"]).toEqual({ key: "#name", label: "Full name", type: "text", required: true, value: "Ana Petrova", source: "profile" });
    expect(byKey["#notice"]).toMatchObject({ type: "select", options: ["Immediately", "1 month", "3 months"], value: "1 month" });
    expect(byKey['[name="consent"]']).toMatchObject({ type: "checkbox", required: true, value: true });
    expect(byKey['[name="newsletter"]']).toMatchObject({ value: false });
    expect(byKey["#cv"]).toMatchObject({ type: "file", required: true, value: null });
    const cv = await db.client.document.findFirstOrThrow({ where: { name: "cv-main" } });
    expect(payload.files).toEqual([{ key: "#cv", document: "cv-main", documentId: cv.documentId, sha256: sha(CV), filename: "Ana Petrova CV.pdf" }]);
    expect((await db.client.step.findFirstOrThrow({ where: { runId, stepKey: "map" } })).output).toMatchObject({ submit: "Send application" });

    // The model saw my profile and the form's labels, as data.
    expect(llm.prompts[0]).toContain(PROFILE);
    expect(llm.prompts[0]).toContain('"label":"Why Acme?"');
    // Read-only: nothing posted, nothing uploaded; the Application is prepared.
    expect(posted()).toEqual([]);
    expect(await db.client.application.findFirstOrThrow()).toMatchObject({ status: "PREPARED", runId });
    // The gate flags nothing new: ats.localhost is in the pipeline's list.
    expect(proposal.targets).toEqual([{ field: "url", kind: "domain", value: "ats.localhost", basis: "static", isNew: false }]);
  });

  it("a form on the posting page, like dev.bg's: the person check is mine to answer, the honeypot stays empty, an AJAX send counts", async () => {
    const source = APPLY().replace(`url: "${postingUrl()}"\n      cv`, `url: "${sites.url("ats", "/jobs/8")}"\n      cv`);
    const { runId, proposal } = await toGate(source);
    const payload = proposal.originalPayload as { url: string; fields: FormField[]; files: FormFile[] };
    expect(payload.url).toBe(sites.url("ats", "/jobs/8"));
    expect(payload.fields.map((f) => [f.label, f.value, f.human ?? false])).toEqual([
      ["Име и Фамилия*", "Ana Petrova", false],
      ["Email*", "ana@aime.test", false],
      ["Започни да пишеш тук...", "I build .NET backends in Sofia.", false],
      ["files", null, false],
      ["101-41=", null, true],
      ["Съгласен съм с политиката за поверителност", true, false],
    ]);
    expect(payload.files).toEqual([expect.objectContaining({ key: "#files-8", document: "cv-main" })]);
    // The model never saw the person check (nor the honeypot).
    expect(llm.prompts[0]).not.toContain("101-41");
    expect(llm.prompts[0]).not.toContain("leave this field empty");

    await approve(proposal);
    const advancing = runner.advance(runId);
    // The check changed with the reload: I answer the one the page asks now.
    const takeover = await until(() => db.client.takeover.findFirst({ where: { runId, status: "OPEN" } }), "the person check");
    expect(takeover.reason).toBe('Answer "102-42=" in the form yourself, then Continue: it is sent then');
    expect(posted()).toEqual([]);
    await db.client.takeover.update({ where: { takeoverId: takeover.takeoverId }, data: { status: "CONTINUED", resolvedAt: new Date() } });
    expect(await advancing).toBe("DONE");

    const [post] = posted();
    expect(post.path).toBe("/apply/8");
    expect(post.body).toContain("Ana Petrova");
    expect(post.body).toMatch(/name="trap"\r\n\r\n\r\n/);
    expect(post.body).toMatch(/name="privacy\[\]"\r\n\r\n1\r\n/);
    expect(post.body).toContain('name="files"; filename="Ana Petrova CV.pdf"');
    expect((await applyStep(runId)).output).toMatchObject({ submitted: true });
    expect(await db.client.application.findFirstOrThrow()).toMatchObject({ status: "SUBMITTED" });
  });

  it("M10-S1: on a form that uploads a file the moment it is picked, mapping attaches nothing and sends nothing", async () => {
    const source = APPLY().replace(`url: "${postingUrl()}"\n      cv`, `url: "${sites.url("ats", "/quick-apply")}"\n      cv`);
    const { proposal } = await toGate(source);
    const payload = proposal.originalPayload as { files: FormFile[] };
    expect(payload.files).toEqual([expect.objectContaining({ key: "#resume", document: "cv-main" })]);
    expect(posted()).toEqual([]);
    expect(sites.hits.filter((h) => h.startsWith("ats.localhost /uploads"))).toEqual([]);
  });

  it("M10-I1: Act fills exactly the approved values, my edit included, through every step of the wizard, and sends it", async () => {
    const { runId, proposal } = await toGate(APPLY());
    await approve(proposal, (p) => {
      const fields = p.fields as FormField[];
      fields.find((f) => f.key === "#phone")!.value = "+359 88 765 4321";
      return p;
    });
    expect(await runner.advance(runId)).toBe("DONE");

    expect(posted()).toHaveLength(1);
    const [post] = posted();
    expect(post.path).toBe("/apply/7");
    const part = (name: string) => new RegExp(`name="${name}"(?:; filename="[^"]*")?\\r\\n(?:Content-Type: [^\\r]*\\r\\n)?\\r\\n([\\s\\S]*?)\\r\\n--`).exec(post.body)?.[1];
    expect(part("name")).toBe("Ana Petrova");
    expect(part("email")).toBe("ana@aime.test");
    expect(part("phone")).toBe("+359 88 765 4321");
    expect(part("notice")).toBe("1 month");
    expect(part("message")).toBe("I build .NET backends in Sofia and would like to do it at Acme.");
    expect(part("consent")).toBe("on");
    expect(part("newsletter")).toBeUndefined();
    expect(post.body).toContain('name="cv"; filename="Ana Petrova CV.pdf"');
    expect(part("cv")).toBe(CV.toString());
    expect(post.body).toMatch(/name="letter"; filename=""/);

    expect((await applyStep(runId)).output).toMatchObject({ submitted: true, confirmation: expect.stringContaining("Your application was received") as unknown });
    expect(await db.client.application.findFirstOrThrow()).toMatchObject({ status: "SUBMITTED", submittedAt: expect.any(Date) as unknown });
    expect(await db.client.jobPosting.findFirstOrThrow()).toMatchObject({ status: "APPLIED" });
  });

  it("M10-I2: a required field added after approval pauses the run; nothing is sent", async () => {
    const { runId, proposal } = await toGate(APPLY());
    await approve(proposal);
    sites.addRequiredField();
    const advancing = runner.advance(runId);
    const takeover = await until(() => db.client.takeover.findFirst({ where: { runId, status: "OPEN" } }), "the pause");
    expect(takeover.reason).toBe('The form changed since I approved it ("Salary expectation" is new and required); nothing was sent');
    expect((await db.client.run.findUniqueOrThrow({ where: { runId } })).status).toBe("WAITING_FOR_USER");

    // Continue on the same form: still not what I approved, so the step fails without sending.
    await db.client.takeover.update({ where: { takeoverId: takeover.takeoverId }, data: { status: "CONTINUED", resolvedAt: new Date() } });
    expect(await advancing).toBe("FAILED");
    expect((await applyStep(runId)).error).toBe('Nothing was sent: "Salary expectation" is new and required');
    expect(posted()).toEqual([]);
    expect(await db.client.application.findFirstOrThrow()).toMatchObject({ status: "PREPARED" });
  });

  it("M10-I3: stopBeforeSubmit fills everything and leaves the final button to me", async () => {
    const { runId, proposal } = await toGate(APPLY("      stopBeforeSubmit: true\n"));
    await approve(proposal);
    const advancing = runner.advance(runId);
    const takeover = await until(() => db.client.takeover.findFirst({ where: { runId, status: "OPEN" } }), "the handover");
    expect(takeover.reason).toBe('Filled as approved: check it and press "Send application" yourself, then Continue');
    expect(posted()).toEqual([]);

    // I didn't press it: Continue reports that nothing was sent.
    await db.client.takeover.update({ where: { takeoverId: takeover.takeoverId }, data: { status: "CONTINUED", resolvedAt: new Date() } });
    expect(await advancing).toBe("DONE");
    expect((await applyStep(runId)).output).toMatchObject({ submitted: false });
    expect(posted()).toEqual([]);
    expect(await db.client.application.findFirstOrThrow()).toMatchObject({ status: "PREPARED" });
  });

  it("M10-S2: a form on an unlisted domain is flagged at the gate; an edited address elsewhere is refused unless approved", async () => {
    const { runId, proposal } = await toGate(APPLY("", ""));
    expect(proposal.targets).toEqual([{ field: "url", kind: "domain", value: "ats.localhost", basis: "provenance", isNew: true }]);

    await approve(proposal, (p) => ({ ...p, url: sites.url("evil", "/apply/7") }));
    expect(await runner.advance(runId)).toBe("FAILED");
    expect((await applyStep(runId)).error).toMatch(/Policy refused domain "evil.localhost"/);
    expect(sites.hits.filter((h) => h.startsWith("evil.localhost"))).toEqual([]);
    expect(posted()).toEqual([]);
  });

  it("a CV replaced after approval is not the one I approved: nothing is sent", async () => {
    const { runId, proposal } = await toGate(APPLY());
    await approve(proposal);
    await document("cv-main", "Ana Petrova CV v2.pdf", Buffer.from("%PDF-1.4\n% newer\n%%EOF\n"));
    // The approved row is still there (replaced, not deleted): its file changed on disk.
    const approved = (proposal.originalPayload as { files: FormFile[] }).files[0];
    const old = await db.client.document.findUniqueOrThrow({ where: { documentId: approved.documentId } });
    await writeFile(join(documentsDir, old.path), "tampered");
    expect(await runner.advance(runId)).toBe("FAILED");
    expect((await applyStep(runId)).error).toBe('The file of "cv-main" changed on disk since I approved it');
    expect(posted()).toEqual([]);
  });
});

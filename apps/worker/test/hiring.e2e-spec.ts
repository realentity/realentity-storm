import { payloadHash } from "@realentity/storm-crypto";
import { createPrismaConnection, type Prisma, type PrismaConnection } from "@realentity/storm-db";
import { entityItem, readAppSource } from "@realentity/storm-shared";
import { exampleYaml } from "@realentity/storm-shared/example-files";
import { defaultCatalog, PipelineCompiler } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/browser/artifact-store";
import { writeZip } from "../src/browser/page-secrets";
import { type MailAttachment, type MailConnector } from "../src/mail/mail-connector";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { AppFileStore, FileKeepStep } from "../src/steps/app-file-steps";
import { SaveStep } from "../src/steps/data-steps";
import { ReadStep } from "../src/steps/entity-steps";
import { FileReadStep } from "../src/steps/file-steps";
import { MapStep } from "../src/steps/map-alert-steps";
import { pdfWithText } from "./support/pdf";
import { Counting, createVersion } from "./support/test-steps";

jest.setTimeout(60_000);

/** An application as email.fetch reads it. */
const email = (uid: number, from: string, fromName: string, subject: string, attachments: string[] = []) => ({
  uid,
  messageId: `<${uid}@${from.split("@")[1]}>`,
  threadId: `<${uid}@${from.split("@")[1]}>`,
  inReplyTo: null,
  references: [],
  from,
  fromName,
  replyTo: from,
  to: ["jobs@mail.example"],
  cc: [],
  subject,
  date: "2026-11-21T09:00:00.000Z",
  text: "Hello, I'd like to apply. My CV is attached.",
  attachments: attachments.map((filename) => ({ filename, contentType: "application/pdf", size: 100 })),
  account: null,
});

// M58-T6: the Hiring App: applicants' CVs kept and scored against your roles; you pick who to invite; invitations and
// a kind no to the others, each batch approved
describe("examples/apps/hiring.yaml", () => {
  const compiler = new PipelineCompiler(defaultCatalog());
  const appSource = exampleYaml("apps/hiring.yaml");
  const definition = readAppSource(appSource);
  let db: PrismaConnection;
  let userId: string;
  let appId: string;
  let root: string;
  let artifactsDir: string;
  let inbox: ReturnType<typeof email>[];
  let attachments: Map<number, MailAttachment[]>;
  let extract: Counting;
  let score: Counting;
  let send: Counting;
  let runner: PipelineRunner;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    root = await mkdtemp(join(tmpdir(), "storm-hiring-files-"));
    artifactsDir = await mkdtemp(join(tmpdir(), "storm-hiring-artifacts-"));
  });

  beforeEach(async () => {
    const app = await db.client.app.create({ data: { userId, name: "Hiring" } });
    const version = await db.client.appVersion.create({ data: { appId: app.appId, version: 1, definition: {}, source: appSource } });
    await db.client.app.update({ where: { appId: app.appId }, data: { currentVersionId: version.appVersionId } });
    appId = app.appId;
    await db.client.dataEntity.create({
      data: { appId, type: "Role", key: "Backend developer", value: { name: "Backend developer" }, mine: { description: "Node.js services, PostgreSQL.", mustHave: "3 years of Node.js" } },
    });
    await db.client.dataEntity.create({ data: { appId, type: "Role", key: "Old role", value: { name: "Old role" }, mine: { description: "Gone.", closed: true } } });

    inbox = [
      email(1, "ana@mail.example", "Ana Petrova", "Application: Backend developer", ["ana-cv.pdf"]),
      email(2, "bo@mail.example", "Bo Berg", "Job application"),
      email(3, "news@shop.example", "Shop", "Weekly deals"),
    ];
    attachments = new Map([[1, [{ filename: "ana-cv.pdf", contentType: "application/pdf", content: pdfWithText("Ana Petrova. Six years of Node.js and PostgreSQL.") }]]]);
    const mail = { attachments: (_who: unknown, request: { uid: number }) => Promise.resolve(attachments.get(request.uid) ?? []) } as unknown as MailConnector;
    const store = new AppFileStore(root);

    const classify = new Counting("email.classify", (input) => {
      const messages = input.messages as ReturnType<typeof email>[];
      const applying = (m: ReturnType<typeof email>) => /appl/i.test(m.subject);
      return {
        kept: messages.filter(applying),
        dropped: messages.filter((m) => !applying(m)),
        results: messages.map((m, index) => ({ index, label: applying(m) ? "application" : "skip", reason: "" })),
      };
    });
    // Ana's CV fits the role; Bo sent no CV and applies for no open role.
    extract = new Counting("llm.extract", (input) => {
      const { cv } = input.content as { cv?: string };
      return cv?.includes("Node.js")
        ? { values: { name: "Ana Petrova", role: "Backend developer", summary: "Backend, Node.js" }, missing: [], found: true }
        : { values: { name: "Bo Berg", role: "Designer", summary: "" }, missing: ["summary"], found: false };
    });
    // M59-T3: llm.score, as ScoreStep answers: the applicant with its score and reason.
    score = new Counting("llm.score", (input) => {
      const scored = (input.items as Record<string, unknown>[]).map((item) => ({ ...item, score: 82, scoreReason: "Six years of Node.js." }));
      return { scored, top: scored };
    });
    send = new Counting("email.send", (input) => ({ messageId: `<sent-${send.calls.length}@mail.example>`, accepted: [input.to], from: "jobs@mail.example" }));
    runner = new PipelineRunner(
      db.client,
      defaultCatalog(),
      new ExecutorRegistry([
        new ReadStep(db.client),
        new SaveStep(db.client, root),
        new MapStep(),
        new FileKeepStep(db.client, store, mail, new ArtifactStore(artifactsDir)),
        new FileReadStep(db.client, undefined, undefined, store),
        new Counting("email.fetch", () => ({ messages: inbox })),
        classify,
        extract,
        score,
        new Counting("llm.generate", () => ({ text: "Thank you for applying: could we talk next week?" })),
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
    await rm(root, { recursive: true, force: true });
    await rm(artifactsDir, { recursive: true, force: true });
  });

  const candidates = async () =>
    Object.fromEntries(
      (await db.client.dataEntity.findMany({ where: { appId, type: "Candidate" }, orderBy: { key: "asc" } })).map((r) => [r.key, { stage: r.stage, ...entityItem(r.value, r.mine) }]),
    );
  /** Each gate, decided as the inbox does: the shortlist picks `invite`; each email approved unless `hold` says no. */
  const decide = async (runId: string, invite: string[], hold: (to: string) => boolean = () => false) => {
    for (let status = await runner.advance(runId); status !== "DONE"; status = await runner.advance(runId)) {
      if (status === "FAILED") {
        const failed = await db.client.step.findMany({ where: { runId, error: { not: null } }, select: { stepKey: true, error: true } });
        throw new Error(failed.map((f) => `${f.stepKey}: ${f.error}`).join("\n"));
      }
      expect(status).toBe("WAITING_FOR_USER");
      for (const p of await db.client.proposal.findMany({ where: { runId, status: "PENDING_REVIEW" } })) {
        const offered = p.originalPayload as { items?: { email: string }[]; to?: string };
        const payload = (p.stepKey === "shortlist" ? { items: offered.items!.filter((i) => invite.includes(i.email)) } : offered) as Prisma.InputJsonValue;
        const status = p.stepKey !== "shortlist" && hold(offered.to!) ? "REJECTED" : "APPROVED";
        await db.client.proposal.update({ where: { proposalId: p.proposalId }, data: { status, finalPayload: payload, payloadHash: payloadHash(payload) } });
      }
    }
  };
  const run = async () =>
    runner.start(await createVersion(db.client, userId, exampleYaml("applications.yaml"), compiler, { app: definition }), { trigger: "schedule", triggerData: {} });

  it("applicants kept with their CV and scored against the open role, the best first; you pick; invitations and a no each go once approved", async () => {
    const runId = await run();
    expect(await runner.advance(runId)).toBe("WAITING_FOR_USER");
    expect((extract.calls[0].content as { cv: string }).cv).toContain("Six years of Node.js");
    expect(extract.calls[0].instruction).toContain('Role "Backend developer": Node.js services, PostgreSQL.\nMust have: 3 years of Node.js');
    expect(extract.calls[0].instruction).not.toContain("Old role");
    // M59-T3: llm.score for Ana, against the open roles, from her email and CV; Bo applies for no open role: not asked.
    expect(score.calls).toHaveLength(1);
    expect(score.calls[0].against).toContain('Role "Backend developer": Node.js services, PostgreSQL.');
    expect(score.calls[0].items).toEqual([
      { role: "Backend developer", email: "Hello, I'd like to apply. My CV is attached.", cv: expect.stringContaining("Six years of Node.js") as unknown },
    ]);

    const listed = await candidates();
    expect(listed["<1@mail.example>"]).toMatchObject({ stage: "new", name: "Ana Petrova", role: "Backend developer", score: 82, why: "Six years of Node.js.", cv: { name: "ana-cv.pdf" } });
    expect(listed["<2@mail.example>"]).toMatchObject({ stage: "new", name: "Bo Berg", score: 0, why: "Applies for no open role." });
    expect((listed["<2@mail.example>"] as { role?: string }).role).toBeUndefined();
    const [review] = await db.client.proposal.findMany({ where: { runId, stepKey: "shortlist" } });
    expect((review.originalPayload as { items: { email: string }[] }).items.map((i) => i.email)).toEqual(["ana@mail.example", "bo@mail.example"]);

    await decide(runId, ["ana@mail.example"]);
    expect(send.calls.map((c) => [c.to, c.subject, c.inReplyTo])).toEqual([
      ["ana@mail.example", "Re: Application: Backend developer", "<1@mail.example>"],
      ["bo@mail.example", "Re: Job application", "<2@mail.example>"],
    ]);
    expect(send.calls[1].body).toContain("Hello Bo Berg,");
    const after = await candidates();
    expect(after["<1@mail.example>"]).toMatchObject({ stage: "invited", cv: { name: "ana-cv.pdf" } });
    expect(after["<2@mail.example>"]).toMatchObject({ stage: "rejected" });
  });

  // M59-T4: a CV in Word is read too, not only kept.
  it("a Word CV (.docx) is kept and read for the score", async () => {
    const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>Bo Berg</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Four years of Node.js </w:t></w:r><w:r><w:t>&amp; PostgreSQL.</w:t></w:r></w:p>
</w:body></w:document>`;
    const cv = writeZip([
      { name: "[Content_Types].xml", data: Buffer.from("<Types/>") },
      { name: "word/document.xml", data: Buffer.from(xml) },
    ]);
    inbox = [{ ...email(2, "bo@mail.example", "Bo Berg", "Job application"), attachments: [{ filename: "bo-cv.docx", contentType: "application/octet-stream", size: cv.length }] }];
    attachments = new Map([[2, [{ filename: "bo-cv.docx", contentType: "application/octet-stream", content: cv }]]]);
    const runId = await run();
    expect(await runner.advance(runId)).toBe("WAITING_FOR_USER");
    expect((extract.calls[0].content as { cv: string }).cv).toBe("Bo Berg\nFour years of Node.js & PostgreSQL.");
    expect((await candidates())["<2@mail.example>"]).toMatchObject({
      cv: { name: "bo-cv.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    });
  });

  it("a no you untick isn't sent, and its applicant stays new", async () => {
    await decide(await run(), [], (to) => to === "bo@mail.example");
    expect(send.calls.map((c) => c.to)).toEqual(["ana@mail.example"]);
    const after = await candidates();
    expect(after["<1@mail.example>"]).toMatchObject({ stage: "rejected" });
    expect(after["<2@mail.example>"]).toMatchObject({ stage: "new" });
  });

  it("no open role: applications aren't read", async () => {
    await db.client.dataEntity.updateMany({ where: { appId, type: "Role" }, data: { mine: { description: "x", closed: true } } });
    await decide(await run(), []);
    expect(extract.calls).toEqual([]);
    expect(await candidates()).toEqual({});
  });
});

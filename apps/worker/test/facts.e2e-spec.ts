import { KeyRing, payloadHash } from "@realentity/storm-crypto";
import { createPrismaConnection, type Prisma, type PrismaConnection, type Proposal } from "@realentity/storm-db";
import { emptyUsage, ModelRouter, type LlmClient, type StructuredRequest } from "@realentity/storm-llm";
import { factKey } from "@realentity/storm-shared";
import { defaultCatalog, type FormField } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type z } from "zod";
import { ArtifactStore } from "../src/browser/artifact-store";
import { BrowserPool } from "../src/browser/browser-pool";
import { DocumentStore } from "../src/browser/document-store";
import { SessionStore } from "../src/browser/session-store";
import { Asker } from "../src/learning/asker";
import { Facts } from "../src/learning/facts";
import { Learning } from "../src/learning/learning";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { RunControls } from "../src/runner/run-controls";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { TakeoverDesk } from "../src/runner/takeovers";
import { CredentialVault } from "../src/secrets/credential-vault";
import { FillAndSubmitStep, MapFormStep } from "../src/steps/form-steps";
import { startFixtureSites, type FixtureSites } from "./support/fixture-sites";
import { createVersion } from "./support/test-steps";

jest.setTimeout(60_000);

const PROFILE = "Ana Petrova · ana@storm.test · +359 88 123 4567 · Sofia · EU citizen · notice period: 1 month";

/**
 * The mapForm model: values from the profile like a real one; the salary from <facts> when one asks it (source
 * fact with its id), else null: the profile doesn't say. `claim` makes it name a fact that isn't mine.
 */
class FactLlm implements LlmClient {
  prompts: string[] = [];
  claim: { factId: string; value: string } | null = null;
  structured<S extends z.ZodObject>(request: StructuredRequest<S>) {
    this.prompts.push(request.prompt);
    const facts = [...(/<facts>\n([\s\S]*?)\n<\/facts>/.exec(request.prompt)?.[1] ?? "").matchAll(/^\{.*\}$/gm)].map(
      (m) => JSON.parse(m[0]) as { id: string; question: string; answer: string },
    );
    const salary = facts.find((f) => /salary/i.test(f.question));
    const answers: Record<string, { value: string | null; source: string; factId?: string }> = {
      "#name": { value: "Ana Petrova", source: "profile" },
      "#email": { value: "ana@storm.test", source: "profile" },
      "#phone": { value: "+359 88 123 4567", source: "profile" },
      "#notice": { value: "1 month", source: "profile" },
      "#message": { value: "I build .NET backends in Sofia.", source: "written" },
      '[name="consent"]': { value: "yes", source: "profile" },
      "#salary": this.claim
        ? { value: this.claim.value, source: "fact", factId: this.claim.factId }
        : salary
          ? { value: salary.answer, source: "fact", factId: salary.id }
          : { value: null, source: "none" },
    };
    const keys = [...request.prompt.matchAll(/\{"key":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);
    const values = keys.map((key) => ({ key, value: answers[key]?.value ?? null, source: answers[key]?.source ?? "none", factId: answers[key]?.factId ?? null }));
    return Promise.resolve({ output: request.schema.parse({ values, notes: "" }), usage: { ...emptyUsage(), calls: 1, costUsd: 0.01 } });
  }
}

// M15: facts about me, from my approvals and my answers; reused by the next form; asked once.
describe("facts about me", () => {
  let db: PrismaConnection;
  let userId: string;
  let sites: FixtureSites;
  let artifactsDir: string;
  let documentsDir: string;
  let pool: BrowserPool;
  let runner: PipelineRunner;
  let learning: Learning;
  const llm = new FactLlm();
  /** What the Storm bot sent: the question messages. */
  const telegram: { text: string; messageId: number }[] = [];

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    sites = await startFixtureSites();
    artifactsDir = await mkdtemp(join(tmpdir(), "storm-artifacts-"));
    documentsDir = await mkdtemp(join(tmpdir(), "storm-documents-"));
    pool = new BrowserPool({ invisible: true });
    const keys = KeyRing.fromEnv(process.env);
    const vault = new CredentialVault(db.client, keys);
    const sendTelegram = (_url: string, init?: { body?: string }) => {
      const messageId = 9000 + telegram.length;
      telegram.push({ text: (JSON.parse(init?.body ?? "{}") as { text: string }).text, messageId });
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: messageId } })));
    };
    const deps = {
      prisma: db.client,
      pool,
      sessions: new SessionStore(db.client, keys, vault),
      vault,
      artifacts: new ArtifactStore(artifactsDir),
      documents: new DocumentStore(documentsDir),
      facts: new Facts(db.client),
      asker: new Asker(db.client, { botToken: "123:abc", chatId: "42" }, "https://storm.test", sendTelegram as unknown as typeof fetch),
    };
    const executors = new ExecutorRegistry([new MapFormStep(deps, llm, new ModelRouter(() => Promise.resolve(null))), new FillAndSubmitStep(deps)]);
    const desk = new TakeoverDesk(db.client, () => Promise.resolve(), { timeoutMs: 15_000, pollMs: 100 });
    runner = new PipelineRunner(db.client, defaultCatalog(), executors, new RunControls(db.client), undefined, desk);
    learning = new Learning(db.client, defaultCatalog(), null);
  });

  beforeEach(async () => {
    await db.client.userSetting.upsert({ where: { userId }, create: { userId, profile: PROFILE }, update: { profile: PROFILE } });
    const cv = Buffer.from("%PDF-1.4\n% CV\n%%EOF\n");
    const row = await db.client.document.create({
      data: { userId, name: "cv-main", filename: "CV.pdf", mime: "application/pdf", size: cv.length, sha256: createHash("sha256").update(cv).digest("hex"), path: "x" },
    });
    await writeFile(join(documentsDir, `${row.documentId}.pdf`), cv);
    await db.client.document.update({ where: { documentId: row.documentId }, data: { path: `${row.documentId}.pdf` } });
    sites.addRequiredField(); // "Salary expectation": no profile says it
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.fact.deleteMany();
    await db.client.document.deleteMany();
    await db.client.userSetting.deleteMany();
    llm.prompts.length = 0;
    llm.claim = null;
    telegram.length = 0;
    sites.reset();
  });

  afterAll(async () => {
    await pool.close();
    await sites.stop();
    await rm(artifactsDir, { recursive: true, force: true });
    await rm(documentsDir, { recursive: true, force: true });
    await db.close();
  });

  const APPLY = (name = "Apply") => `name: ${name}
policy: { allowedDomains: [ats.localhost] }
steps:
  - id: map
    type: browser.mapForm
    with: { url: "${sites.url("ats", "/jobs/7")}", cv: cv-main }
  - id: apply
    type: browser.fillAndSubmit
    with: { url: "{{map.formUrl}}", fields: "{{map.fields}}", files: "{{map.files}}" }
`;
  const until = async <T>(read: () => Promise<T | null | undefined>, what: string): Promise<T> => {
    for (let i = 0; i < 300; i++) {
      const value = await read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${what}`);
  };
  /** What the api does with my answer (FactsService.answer): the fact, the question answered, the wait continued. */
  async function answer(questionId: string, text: string) {
    const question = await db.client.question.findUniqueOrThrow({ where: { questionId } });
    const fact = await db.client.fact.create({ data: { userId, key: factKey(question.question), question: question.question, answer: text, source: "ASKED", site: question.site } });
    await db.client.question.update({ where: { questionId }, data: { status: "ANSWERED", answer: text, factId: fact.factId, answeredAt: new Date() } });
    await db.client.takeover.updateMany({ where: { runId: question.runId, waitsFor: "answer", status: "OPEN" }, data: { status: "CONTINUED" } });
    return fact;
  }
  const field = (proposal: Proposal, label: string) => ((proposal.originalPayload as { fields: FormField[] }).fields).find((f) => f.label === label)!;
  async function decide(proposal: Proposal, kind: "APPROVED" | "EDITED" | "REJECTED", edit = (p: Record<string, unknown>) => p) {
    const finalPayload = edit(structuredClone(proposal.originalPayload as Record<string, unknown>));
    await db.client.proposal.update({
      where: { proposalId: proposal.proposalId },
      data: kind === "REJECTED" ? { status: "REJECTED" } : { status: "APPROVED", finalPayload: finalPayload as Prisma.InputJsonValue, payloadHash: payloadHash(finalPayload) },
    });
    await db.client.decision.create({ data: { proposalId: proposal.proposalId, kind } });
    await learning.fromProposal(proposal.proposalId);
  }

  it("M15-I1: asked once (Telegram), answered, the run goes on with it; the next form reuses it without asking", async () => {
    const runId = await runner.start(await createVersion(db.client, userId, APPLY()), { trigger: "manual" });
    const advancing = runner.advance(runId);

    // The wait, not the question: it is asked, sent on Telegram, then waited for (answered earlier, nothing continues).
    await until(() => db.client.takeover.findFirst({ where: { runId, waitsFor: "answer", status: "OPEN" } }), "the wait for my answer");
    const question = await db.client.question.findFirstOrThrow({ where: { runId, status: "OPEN" } });
    expect(question).toMatchObject({ question: "Salary expectation", site: "ats.localhost", stepKey: "map", options: [] });
    expect(telegram).toHaveLength(1);
    expect(telegram[0].text).toMatch(/^Storm asks \(a form on ats\.localhost\): Salary expectation\n\nReply to this message/);
    expect(await db.client.question.findUniqueOrThrow({ where: { questionId: question.questionId } })).toMatchObject({ telegramMessageId: 9000 });
    expect(await db.client.takeover.findFirstOrThrow({ where: { runId, status: "OPEN" } })).toMatchObject({ waitsFor: "answer" });

    const fact = await answer(question.questionId, "4 000 EUR net per month");
    expect(await advancing).toBe("WAITING_FOR_USER");
    const first = await db.client.proposal.findFirstOrThrow({ where: { runId } });
    expect(field(first, "Salary expectation")).toMatchObject({
      value: "4 000 EUR net per month",
      source: "asked",
      fact: { factId: fact.factId, question: "Salary expectation" },
    });

    // The next application: the fact is in the prompt, the field filled from it, nobody asked.
    const next = await runner.start(await createVersion(db.client, userId, APPLY("Apply again")), { trigger: "manual" });
    expect(await runner.advance(next)).toBe("WAITING_FOR_USER");
    expect(llm.prompts.at(-1)).toContain(`{"id":"${fact.factId}","question":"Salary expectation","answer":"4 000 EUR net per month"}`);
    const second = await db.client.proposal.findFirstOrThrow({ where: { runId: next } });
    expect(field(second, "Salary expectation")).toMatchObject({ value: "4 000 EUR net per month", source: "fact", fact: { factId: fact.factId } });
    expect(await db.client.question.count({ where: { runId: next } })).toBe(0);
    expect(telegram).toHaveLength(1);
    expect(await db.client.fact.findUniqueOrThrow({ where: { factId: fact.factId } })).toMatchObject({ uses: 1, lastUsedAt: expect.any(Date) as unknown });
  });

  it("M15-T1: what I fill in or change at the gate becomes a fact; free text, unchanged values and rejections don't", async () => {
    await db.client.fact.create({ data: { userId, key: factKey("Salary expectation"), question: "Salary expectation", answer: "3 500 EUR", source: "ME" } });
    const runId = await runner.start(await createVersion(db.client, userId, APPLY()), { trigger: "manual" });
    expect(await runner.advance(runId)).toBe("WAITING_FOR_USER");
    const proposal = await db.client.proposal.findFirstOrThrow({ where: { runId } });
    await decide(proposal, "EDITED", (payload) => {
      const fields = payload.fields as FormField[];
      for (const f of fields) {
        if (f.label === "Phone") f.value = "+359 88 999 0000";
        if (f.label === "Salary expectation") f.value = "4 200 EUR";
        if (f.label === "Why Acme?") f.value = "Because of the product.";
      }
      return payload;
    });
    const facts = await db.client.fact.findMany({ where: { userId }, orderBy: { question: "asc" } });
    expect(facts.map((f) => [f.question, f.answer, f.source, f.site])).toEqual([
      ["Phone", "+359 88 999 0000", "FORM", "ats.localhost"],
      ["Salary expectation", "4 200 EUR", "FORM", "ats.localhost"],
    ]);

    // Rejected: nothing new, nothing changed (the salary is a fact by now, so nothing is asked).
    const other = await runner.start(await createVersion(db.client, userId, APPLY("Apply 2")), { trigger: "manual" });
    expect(await runner.advance(other)).toBe("WAITING_FOR_USER");
    await decide(await db.client.proposal.findFirstOrThrow({ where: { runId: other } }), "REJECTED", (payload) => {
      for (const f of payload.fields as FormField[]) if (f.label === "Phone") f.value = "+1 000";
      return payload;
    });
    expect((await db.client.fact.findMany({ orderBy: { question: "asc" } })).map((f) => f.answer)).toEqual(["+359 88 999 0000", "4 200 EUR"]);
  });

  it("M15-S1: a form step never writes a fact, and a fact the LLM names that isn't mine (or with another answer) fills nothing", async () => {
    const mine = await db.client.fact.create({ data: { userId, key: factKey("Salary expectation"), question: "Salary expectation", answer: "4 000 EUR", source: "ME" } });
    // A made-up fact id, and my fact with an answer it changed: neither fills the field.
    for (const claim of [
      { factId: "00000000-0000-4000-8000-000000000bad", value: "1 EUR" },
      { factId: mine.factId, value: "1 EUR" },
    ]) {
      llm.claim = claim;
      const runId = await runner.start(await createVersion(db.client, userId, APPLY(`Apply ${claim.factId.slice(0, 4)}`)), { trigger: "manual", dryRun: true });
      const advancing = runner.advance(runId);
      // The field is empty, so the step asks me; I don't answer: the field stays empty for the gate.
      await until(() => db.client.takeover.findFirst({ where: { runId, waitsFor: "answer", status: "OPEN" } }), "the wait for my answer");
      const question = await db.client.question.findFirstOrThrow({ where: { runId, status: "OPEN" } });
      await db.client.takeover.updateMany({ where: { runId, waitsFor: "answer", status: "OPEN" }, data: { status: "CONTINUED" } });
      expect(await advancing).toBe("DONE");
      const map = await db.client.step.findFirstOrThrow({ where: { runId, stepKey: "map" } });
      expect((map.output as { fields: FormField[] }).fields.find((f) => f.label === "Salary expectation")).toMatchObject({ value: null, source: "none" });
      expect(await db.client.question.findUniqueOrThrow({ where: { questionId: question.questionId } })).toMatchObject({ status: "EXPIRED" });
    }
    // Mapping (and a page's text) wrote nothing: still only my fact, unchanged.
    expect(await db.client.fact.findMany()).toEqual([expect.objectContaining({ factId: mine.factId, answer: "4 000 EUR", uses: 0 })]);
  });
});

import { createPrismaConnection, type PrismaConnection } from "@ai-me/db";
import { emptyUsage, ModelRouter, type LlmClient, type StructuredRequest } from "@ai-me/llm";
import { defaultCatalog, type EmailMessage } from "@ai-me/steps";
import { TestEnvironment } from "@ai-me/testing";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type z } from "zod";
import { WeeklyReview } from "../src/jobs/weekly-review";
import { NO_ATTENTION, type StepContext } from "../src/runner/step-executor";
import { ApplicationOutcomeStep } from "../src/steps/application-steps";
import { DedupeStep, SaveStep } from "../src/steps/data-steps";
import { prepareApplication, submitApplication } from "../src/steps/form-steps";
import { ScoreStep } from "../src/steps/llm-steps";

const JOB_SEARCH = readFileSync(join(__dirname, "../../../pipelines/apps/job-search.yaml"), "utf8");

/** Answers what it's told to; keeps the prompts. */
class Scripted implements LlmClient {
  prompts: string[] = [];
  answer: (prompt: string) => unknown = () => ({});
  structured<S extends z.ZodObject>(request: StructuredRequest<S>) {
    this.prompts.push(request.prompt);
    return Promise.resolve({
      output: request.schema.parse(this.answer(request.prompt)),
      usage: { ...emptyUsage(), calls: 1, costUsd: 0.001 },
    });
  }
}

const email = (from: string, subject: string, text: string): EmailMessage => ({
  uid: 1,
  messageId: `<${subject}@mail.test>`,
  threadId: `<${subject}@mail.test>`,
  inReplyTo: null,
  references: [],
  from,
  fromName: null,
  replyTo: from,
  to: ["ana@aime.test"],
  cc: [],
  subject,
  date: new Date().toISOString(),
  text,
  attachments: [],
});

// M33-I1 (Job Search): the job steps on the Jobs of the pipeline's App, still telling application.status
describe("M33: Job Search on Apps", () => {
  let db: PrismaConnection;
  let userId: string;
  let appId: string;
  let emitted: { event: string; data: Record<string, unknown> }[];
  const catalog = defaultCatalog();

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(async () => {
    emitted = [];
    const app = await db.client.app.create({ data: { userId, name: "Job Search" } });
    const version = await db.client.appVersion.create({ data: { appId: app.appId, version: 1, definition: {}, source: JOB_SEARCH } });
    await db.client.app.update({ where: { appId: app.appId }, data: { currentVersionId: version.appVersionId } });
    appId = app.appId;
  });

  afterEach(async () => {
    await db.client.app.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  const context = (dryRun = false): StepContext => ({
    runId: "00000000-0000-4000-8000-000000000001",
    userId,
    pipelineId: "00000000-0000-4000-8000-000000000002",
    stepId: "s",
    stepKey: "k",
    itemIndex: null,
    dryRun,
    app: "Job Search",
    recordUsage: () => undefined,
    attention: NO_ATTENTION,
    emit: (event, data) => {
      emitted.push({ event, data });
      return Promise.resolve();
    },
  });
  const job = (key: string, extra: Record<string, unknown> = {}) => ({
    url: `https://dev.bg/company/jobads/${key}/`,
    title: `${key} engineer`,
    company: key[0].toUpperCase() + key.slice(1),
    score: 80,
    ...extra,
  });
  const save = (items: Record<string, unknown>[], stage?: string) =>
    new SaveStep(db.client).execute(catalog.get("data.save")!.input.parse({ items, type: "Job", ...(stage ? { stage } : {}) }), context());
  const stageOf = async (key: string) =>
    (await db.client.dataEntity.findUniqueOrThrow({ where: { appId_type_key: { appId, type: "Job", key: job(key).url } } })).stage;

  it("keeps jobs as Jobs: new, skipped and shortlisted by data.save, each seen once by data.dedupe", async () => {
    await save([job("acme"), job("globex")]);
    await save([job("initech")], "skipped");
    await save([job("acme")], "shortlisted");
    expect([await stageOf("acme"), await stageOf("globex"), await stageOf("initech")]).toEqual(["shortlisted", "new", "skipped"]);

    const deduped = (await new DedupeStep(db.client).execute(
      catalog.get("data.dedupe")!.input.parse({ from: [job("acme"), job("hooli")], key: "url", againstType: "Job" }),
      context(),
    )) as { items: { url: string }[]; duplicates: number };
    expect([deduped.items.map((i) => i.url), deduped.duplicates]).toEqual([[job("hooli").url], 1]);
  });

  it("the form steps move a Job to prepared and applied, telling application.status as before", async () => {
    await save([job("acme")], "shortlisted");
    emitted = [];
    await prepareApplication(db.client, context(), job("acme").url);
    await submitApplication(db.client, context(), job("acme").url);
    expect(await stageOf("acme")).toBe("applied");
    const entity = await db.client.dataEntity.findFirstOrThrow({ where: { appId, type: "Job" } });
    expect(Object.keys(entity.stageDates as object).sort()).toEqual(["applied", "prepared", "shortlisted"]);
    expect(emitted.filter((e) => e.event === "application.status").map((e) => e.data)).toEqual([
      {
        applicationId: entity.dataEntityId,
        status: "PREPARED",
        job: { title: "acme engineer", company: "Acme", location: null, url: job("acme").url },
      },
      {
        applicationId: entity.dataEntityId,
        status: "SUBMITTED",
        job: { title: "acme engineer", company: "Acme", location: null, url: job("acme").url },
      },
    ]);
    // Prepared again (a retried run) after it was sent: it stays applied.
    await prepareApplication(db.client, context(), job("acme").url);
    expect(await stageOf("acme")).toBe("applied");
  });

  it("application.outcome moves an applied Job forward only, notes the email, and calibrates llm.score", async () => {
    await save([job("acme"), job("globex", { score: 40 })]);
    for (const key of ["acme", "globex"]) await submitApplication(db.client, context(), job(key).url);
    const entity = await db.client.dataEntity.findFirstOrThrow({ where: { appId, key: job("acme").url } });
    const llm = new Scripted();
    const outcome = new ApplicationOutcomeStep(db.client, llm, new ModelRouter(() => Promise.resolve(null)));
    const read = (subject: string, answer: "interview" | "responded") => {
      llm.answer = () => ({ applicationId: entity.dataEntityId, outcome: answer, reason: "they say so" });
      return outcome.execute({ message: email("hr@acme.test", subject, "Hello") }, context()) as Promise<{
        changed: boolean;
        status: string;
        job: { company: string };
      }>;
    };

    emitted = [];
    expect(await read("Interview invitation", "interview")).toMatchObject({ changed: true, status: "INTERVIEW", job: { company: "Acme" } });
    expect(llm.prompts[0]).toContain('"status":"SUBMITTED"');
    expect(emitted.map((e) => [e.event, e.data.status ?? (e.data.stage as { to: string }).to])).toEqual([
      ["entity.changed", "interview"],
      ["application.status", "INTERVIEW"],
    ]);
    // An older email saying they answered doesn't move it back.
    expect(await read("Re: your application", "responded")).toMatchObject({ changed: false });
    const moved = await db.client.dataEntity.findFirstOrThrow({ where: { appId, key: job("acme").url } });
    expect([moved.stage, (moved.mine as { comments: string }).comments]).toEqual([
      "interview",
      expect.stringContaining('interview: "Interview invitation" from hr@acme.test') as unknown,
    ]);

    // The interview reaches llm.score's calibration.
    const scoring = new Scripted();
    scoring.answer = () => ({ results: [{ index: 0, score: 50, reason: "ok" }] });
    await new ScoreStep(scoring, new ModelRouter(() => Promise.resolve(null)), undefined, db.client).execute(
      catalog.get("llm.score")!.input.parse({ items: [{ title: "x" }], against: "Senior roles", outcomes: true }),
      context(),
    );
    expect(scoring.prompts[0]).toContain('"title":"acme engineer"');
    expect(scoring.prompts[0]).toContain('"outcome":"interview"');
  });

  it("the weekly review counts this week's applications from the Jobs", async () => {
    await save([job("acme"), job("globex")]);
    for (const key of ["acme", "globex"]) await submitApplication(db.client, context(), job(key).url);
    const review = new WeeklyReview(db.client, {} as never, () => Promise.resolve());
    const text = await (review as unknown as { outcomes(userId: string, since: Date): Promise<string | null> }).outcomes(
      userId,
      new Date(Date.now() - 7 * 86_400_000),
    );
    expect(text).toBe("Applications: 2 sent, 0 answered, 0 interview(s), 0 turned down");
  });
});

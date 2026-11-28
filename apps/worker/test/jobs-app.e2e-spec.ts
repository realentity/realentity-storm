import { exampleYaml } from "@realentity/storm-shared/example-files";
import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { emptyUsage, ModelRouter, type LlmClient, type LlmUsage, type StructuredRequest } from "@realentity/storm-llm";
import { readAppSource } from "@realentity/storm-shared";
import { defaultCatalog, PipelineCompiler, type EmailMessage } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { type z } from "zod";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry, NO_ATTENTION, type StepContext } from "../src/runner/step-executor";
import { DedupeStep, FilterStep, SaveStep } from "../src/steps/data-steps";
import { ReadStep } from "../src/steps/entity-steps";
import { ClassifyStep, ExtractStep, ScoreStep } from "../src/steps/llm-steps";
import { MapStep } from "../src/steps/map-alert-steps";
import { Counting, createVersion } from "./support/test-steps";

jest.setTimeout(60_000);

const JOB_SEARCH = exampleYaml("apps/job-search.yaml");

/**
 * The LLM as the App's steps ask it: llm.classify keeps every posting (an employer), llm.score gives each 75, and
 * llm.extract reads a reply by its subject (an interview, an answer, or an automatic one about none). Keeps the prompts.
 */
class Recruiter implements LlmClient {
  prompts: { system: string; prompt: string }[] = [];
  /** The Job a reply is about (llm.extract's `job`). */
  replyTo = "";
  structured<S extends z.ZodObject>(request: StructuredRequest<S>): Promise<{ output: z.infer<S>; usage: LlmUsage }> {
    this.prompts.push({ system: request.system, prompt: request.prompt });
    const usage = { ...emptyUsage(), calls: 1, costUsd: 0.001 };
    const indexes = [...request.prompt.matchAll(/\{"index":(\d+)/g)].map(([, index]) => Number(index));
    if (request.system.startsWith("You label items")) {
      return Promise.resolve({ output: request.schema.parse({ results: indexes.map((index) => ({ index, label: "employer", reason: "test" })) }), usage });
    }
    if (request.system.startsWith("You score")) {
      return Promise.resolve({ output: request.schema.parse({ results: indexes.map((index) => ({ index, score: 75, reason: "fits" })) }), usage });
    }
    const outcome = request.prompt.includes("Interview invitation") ? "interview" : request.prompt.includes("Re: your application") ? "responded" : "none";
    const values = [
      { name: "job", value: outcome === "none" ? "" : this.replyTo },
      { name: "outcome", value: outcome },
      { name: "reason", value: outcome === "interview" ? "They invite you to a call." : outcome === "responded" ? "They ask a question." : "An automatic reply." },
    ];
    return Promise.resolve({ output: request.schema.parse({ values }), usage });
  }
}

const email = (from: string, subject: string): EmailMessage => ({
  uid: 1,
  messageId: `<${subject}@mail.test>`,
  threadId: `<${subject}@mail.test>`,
  inReplyTo: null,
  references: [],
  from,
  fromName: null,
  replyTo: from,
  to: ["ana@storm.test"],
  cc: [],
  subject,
  date: new Date().toISOString(),
  text: "Hello",
  attachments: [],
});

// M33-I1, M71 (Job Search): the App's pipelines on generic steps only
describe("examples/apps/job-search.yaml", () => {
  const catalog = defaultCatalog();
  const compiler = new PipelineCompiler(catalog);
  const app = readAppSource(JOB_SEARCH);
  let db: PrismaConnection;
  let userId: string;
  let appId: string;
  let llm: Recruiter;
  let inbox: EmailMessage[];
  let fetch: Counting;
  let board: Counting;
  let telegram: Counting;
  let runner: PipelineRunner;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(async () => {
    const created = await db.client.app.create({ data: { userId, name: "Job Search" } });
    const version = await db.client.appVersion.create({ data: { appId: created.appId, version: 1, definition: {}, source: JOB_SEARCH } });
    await db.client.app.update({ where: { appId: created.appId }, data: { currentVersionId: version.appVersionId } });
    appId = created.appId;
    llm = new Recruiter();
    inbox = [];
    fetch = new Counting("email.fetch", () => ({ messages: inbox, problems: [] }));
    board = new Counting("browser.extract", () => ({ items: [posting("hooli"), posting("umbrella")], pages: 1 }));
    telegram = new Counting("notify.telegram", () => ({ sent: true }));
    const router = new ModelRouter(() => Promise.resolve(null));
    runner = new PipelineRunner(
      db.client,
      catalog,
      new ExecutorRegistry([
        fetch,
        // Every email is about an application (the triage is llm.classify's, tested on its own).
        new Counting("email.classify", (input) => ({ kept: input.messages, dropped: [], results: [] })),
        board,
        new DedupeStep(db.client),
        new ClassifyStep(llm, router),
        new ScoreStep(llm, router),
        new ExtractStep(llm, router),
        new ReadStep(db.client),
        new MapStep(),
        new SaveStep(db.client),
        new FilterStep(),
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
  });

  const context: StepContext = {
    runId: "00000000-0000-4000-8000-000000000001",
    userId: "",
    pipelineId: "00000000-0000-4000-8000-000000000002",
    stepId: "s",
    stepKey: "k",
    itemIndex: null,
    dryRun: false,
    app: "Job Search",
    recordUsage: () => undefined,
    attention: NO_ATTENTION,
  };
  const job = (key: string, extra: Record<string, unknown> = {}) => ({
    url: `https://jobs.example.com/ads/${key}/`,
    title: `${key} engineer`,
    company: key[0].toUpperCase() + key.slice(1),
    score: 80,
    ...extra,
  });
  const posting = (key: string) => ({ url: job(key).url, title: job(key).title, company: job(key).company, location: "Remote" });
  /** Jobs saved and moved as a pipeline moves them, one stage after the other. */
  const keep = async (items: Record<string, unknown>[], ...stages: string[]) => {
    const save = new SaveStep(db.client);
    const ctx = { ...context, userId };
    await save.execute(catalog.get("data.save")!.input.parse({ items, type: "Job" }), ctx);
    for (const stage of stages) await save.execute(catalog.get("data.save")!.input.parse({ items, type: "Job", stage }), ctx);
  };
  const entity = (key: string) => db.client.dataEntity.findUniqueOrThrow({ where: { appId_type_key: { appId, type: "Job", key: job(key).url } } });
  /** A pipeline of the App run to its end; what it told on Telegram. */
  const run = async (pipeline: string, dryRun = false): Promise<string[]> => {
    const versionId = await createVersion(db.client, userId, exampleYaml(pipeline), compiler, { app });
    const before = telegram.calls.length;
    const runId = await runner.start(versionId, { trigger: "manual", dryRun });
    const status = await runner.advance(runId);
    if (status !== "DONE") {
      const failed = await db.client.step.findMany({ where: { runId, error: { not: null } }, select: { stepKey: true, error: true } });
      throw new Error(`${status}: ${failed.map((f) => `${f.stepKey}: ${f.error}`).join("\n")}`);
    }
    return telegram.calls.slice(before).map((c) => c.text as string);
  };

  it("application-replies moves the Job an email is about forward only, keeps what's mine, and tells", async () => {
    await keep([job("acme"), job("globex", { score: 40 })], "applied");
    await keep([job("initech")]);
    await db.client.dataEntity.update({ where: { dataEntityId: (await entity("acme")).dataEntityId }, data: { mine: { comments: "met them at a meetup" } } });
    llm.replyTo = job("acme").url;
    inbox = [email("hr@acme.test", "Interview invitation"), email("noreply@globex.test", "We received your application")];

    // A dry run moves nothing, and tells as a run would.
    expect(await run("application-replies", true)).toHaveLength(1);
    expect((await entity("acme")).stage).toBe("applied");

    expect(await run("application-replies")).toEqual([`Acme (acme engineer): interview. They invite you to a call.\n${job("acme").url}`]);
    // Only the open applications are offered, without their descriptions or my comments.
    const asked = llm.prompts.at(-1)!.prompt;
    const offered = JSON.parse(/<content>\n([\s\S]*)\n<\/content>/.exec(asked)![1]) as { applications: unknown[] };
    expect(offered.applications).toHaveLength(2);
    expect(offered.applications).toEqual(
      expect.arrayContaining([
        { url: job("acme").url, title: "acme engineer", company: "Acme", status: "applied" },
        { url: job("globex").url, title: "globex engineer", company: "Globex", status: "applied" },
      ]),
    );
    expect(asked).not.toContain("initech");
    expect(asked).not.toContain("meetup");
    const acme = await entity("acme");
    expect([acme.stage, Object.keys(acme.stageDates as object).sort(), acme.mine, acme.value]).toEqual([
      "interview",
      ["applied", "interview", "new"],
      { comments: "met them at a meetup" },
      // What was read stays, and nothing of the reply (its reason) is kept on the Job.
      { url: job("acme").url, title: "acme engineer", company: "Acme", score: 80 },
    ]);
    expect((await entity("globex")).stage).toBe("applied");

    // An older email saying they answered doesn't move it back, and says nothing.
    inbox = [email("hr@acme.test", "Re: your application")];
    expect(await run("application-replies")).toEqual([]);
    expect((await entity("acme")).stage).toBe("interview");
  });

  it("application-replies reads no email without an open application", async () => {
    await keep([job("acme")]);
    inbox = [email("hr@acme.test", "Interview invitation")];
    expect(await run("application-replies")).toEqual([]);
    expect(fetch.calls).toHaveLength(0);
  });

  it("job-board scores new postings with what came of my last applications, and keeps them as Jobs", async () => {
    await keep([job("acme")], "applied", "interview", "rejected");
    await keep([job("globex"), job("soylent")], "applied");
    await keep([job("initech")]);
    // Globex never answered: applied four weeks ago. Soylent applied today: too soon to say.
    const globex = await entity("globex");
    const weeksAgo = new Date(Date.now() - 28 * 86_400_000).toISOString();
    await db.client.dataEntity.update({ where: { dataEntityId: globex.dataEntityId }, data: { stageDates: { ...(globex.stageDates as object), applied: weeksAgo } } });

    const told = await run("job-board");
    expect(told).toEqual([expect.stringContaining("75: hooli engineer at Hooli, Remote."), expect.stringContaining("75: umbrella engineer at Umbrella, Remote.")]);
    const scoring = llm.prompts.find((p) => p.system.startsWith("You score"))!.prompt;
    const past = /<past>\n([\s\S]*?)\n<\/past>/.exec(scoring)![1].split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    // An interview that ended in a rejection was still an interview; the newest application first.
    expect(past).toEqual([
      { title: "acme engineer", company: "Acme", scoredThen: 80, outcome: "interview" },
      { title: "globex engineer", company: "Globex", scoredThen: 80, outcome: "no answer in 3 weeks" },
    ]);
    expect((await entity("hooli")).value).toMatchObject({ score: 75, scoreReason: "fits", location: "Remote" });
    // Nothing of what data.read says about an entity is kept with one.
    expect(JSON.stringify((await entity("acme")).value)).not.toContain("@");

    // Seen before: neither scored nor told again.
    const prompts = llm.prompts.length;
    expect(await run("job-board")).toEqual([]);
    expect(llm.prompts.length).toBe(prompts);
  });
});

import { KeyRing } from "@ai-me/crypto";
import { createPrismaConnection, type PrismaConnection } from "@ai-me/db";
import { emptyUsage, ModelRouter, type LlmClient, type StructuredRequest } from "@ai-me/llm";
import { TestEnvironment } from "@ai-me/testing";
import { type TelegramMessage } from "@ai-me/shared";
import { defaultCatalog, type Recipe } from "@ai-me/steps";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type z } from "zod";
import { ArtifactStore } from "../src/browser/artifact-store";
import { BrowserPool } from "../src/browser/browser-pool";
import { SessionStore } from "../src/browser/session-store";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { RunControls } from "../src/runner/run-controls";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { TakeoverDesk } from "../src/runner/takeovers";
import { CredentialVault } from "../src/secrets/credential-vault";
import { DedupeStep, SaveStep } from "../src/steps/data-steps";
import { BrowserExtractStep } from "../src/steps/recipe-steps";
import { BrowserAgentStep } from "../src/steps/agent-steps";
import { RecipeFallback } from "../src/steps/recipe-fallback";
import { BrowserTeachStep, RecipeWriter } from "../src/steps/teach-step";
import { JOBS, startFixtureSites, type FixtureSites } from "./support/fixture-sites";
import { click, ScriptedChat } from "./support/scripted-chat";
import { createVersion } from "./support/test-steps";

jest.setTimeout(60_000);

/** Answers the teach step with the proposals given, in order; records the prompts. */
class ScriptedLlm implements LlmClient {
  prompts: string[] = [];
  /** Each call's cached start of the prompt (the page, in teach mode). */
  cached: (string | undefined)[] = [];
  constructor(private readonly answers: unknown[]) {}
  structured<S extends z.ZodObject>(request: StructuredRequest<S>) {
    this.prompts.push(`${request.cachedPrompt ?? ""}${request.prompt}`);
    this.cached.push(request.cachedPrompt);
    const answer = this.answers.shift();
    if (!answer) return Promise.reject(new Error("no more answers"));
    return Promise.resolve({ output: request.schema.parse(answer), usage: { ...emptyUsage(), calls: 1, costUsd: 0.02 } });
  }
}

// M9: recipes (browser.extract), job postings (data.dedupe against JobPosting, data.save) and teach mode against the
// local job board (no real site)
describe("recipes and job postings", () => {
  let db: PrismaConnection;
  let userId: string;
  let sites: FixtureSites;
  let artifactsDir: string;
  let pool: BrowserPool;
  let llm: ScriptedLlm;
  let runner: PipelineRunner;
  const notified: string[] = [];
  /** The agent of the fallback (M11-T3). */
  const chat = new ScriptedChat();

  /** The job board as recipe "jobs.localhost/search" (the port is the fixture server's). */
  const boardRecipe = (next: Recipe["next"] = { kind: "link", selector: "a.next" }): Recipe => ({
    url: sites.url("jobs", "/search?q={query}"),
    params: { query: { description: "what to search" } },
    item: "article.job",
    fields: {
      url: { selector: "a.job-title", attr: "href", required: true },
      title: { selector: "a.job-title", required: true },
      company: { selector: ".company", required: false },
      location: { selector: ".location", required: false },
    },
    key: "url",
    empty: ".no-results",
    next,
    maxPages: 5,
    delayMs: 500,
  });

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    sites = await startFixtureSites();
    artifactsDir = await mkdtemp(join(tmpdir(), "aime-artifacts-"));
    pool = new BrowserPool({ invisible: true });
    const keys = KeyRing.fromEnv(process.env);
    const vault = new CredentialVault(db.client, keys);
    const deps = {
      prisma: db.client,
      pool,
      sessions: new SessionStore(db.client, keys, vault),
      vault,
      artifacts: new ArtifactStore(artifactsDir),
      notify: (message: string | TelegramMessage) => {
        notified.push(typeof message === "string" ? message : message.text);
        return Promise.resolve();
      },
    };
    llm = new ScriptedLlm([]);
    const router = new ModelRouter(() => Promise.resolve(null));
    const scripted: LlmClient = { structured: (request) => llm.structured(request) };
    const teach = new BrowserTeachStep(deps, scripted, router);
    const fallback = new RecipeFallback(deps, new BrowserAgentStep({ ...deps, chat, router }), new RecipeWriter(scripted, router));
    const executors = new ExecutorRegistry([
      new BrowserExtractStep(deps, () => Promise.resolve(), fallback),
      new DedupeStep(db.client),
      new SaveStep(db.client),
      teach,
    ]);
    const desk = new TakeoverDesk(db.client, () => Promise.resolve(), { timeoutMs: 10_000, pollMs: 100 });
    runner = new PipelineRunner(db.client, defaultCatalog(), executors, new RunControls(db.client), undefined, desk);
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.siteRecipe.deleteMany();
    await db.client.jobPosting.deleteMany();
    notified.length = 0;
    sites.reset();
  });

  afterAll(async () => {
    await pool.close();
    await sites.stop();
    await rm(artifactsDir, { recursive: true, force: true });
    await db.close();
  });

  const saveRecipe = (recipe: Recipe, version = 1) =>
    db.client.siteRecipe.create({
      data: { userId, name: "jobs.localhost/search", site: "jobs.localhost", version, steps: recipe },
    });
  const run = async (source: string) => {
    const runId = await runner.start(await createVersion(db.client, userId, source), { trigger: "manual" });
    return { runId, status: await runner.advance(runId) };
  };
  const output = async (runId: string, stepKey: string) =>
    (await db.client.step.findFirstOrThrow({ where: { runId, stepKey } })).output as Record<string, unknown>;
  const until = async <T>(read: () => Promise<T | null | undefined>, what: string): Promise<T> => {
    for (let i = 0; i < 200; i++) {
      const value = await read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${what}`);
  };

  const SEARCH = (query = "net", timeoutSeconds = 30) => `name: Jobs
steps:
  - id: search
    type: browser.extract
    with:
      recipes: [jobs.localhost/search]
      params: { query: ${query} }
      timeoutSeconds: ${timeoutSeconds}
`;
  const DAILY = `${SEARCH()}  - id: fresh
    type: data.dedupe
    with: { from: "{{search.items}}", key: url, against: JobPosting }
  - id: save
    type: data.save
    with: { items: "{{fresh.items}}" }
`;

  it("M9-I1: reads every item of the list across its pages, by next link or by page number, without the ad", async () => {
    // Page numbers have no "last page" mark: the fourth, empty, page ends the list.
    for (const [version, next, opened] of [
      [1, { kind: "link", selector: "a.next" }, 3],
      [2, { kind: "page", url: sites.url("jobs", "/search?q={query}&page={page}"), start: 2 }, 4],
    ] as const) {
      const recipe = await saveRecipe(boardRecipe(next), version);
      const { runId, status } = await run(SEARCH());
      expect(status).toBe("DONE");
      const { items, pages } = await output(runId, "search");
      expect(pages).toBe(opened);
      expect(items).toEqual(
        JOBS.map((job) => ({
          url: sites.url("jobs", `/jobs/${job.id}`),
          title: job.title,
          company: job.company,
          location: job.location,
          source: "jobs.localhost/search",
        })),
      );
      expect((await db.client.siteRecipe.findUniqueOrThrow({ where: { siteRecipeId: recipe.siteRecipeId } })).lastVerifiedAt).not.toBeNull();
    }
    // Only the latest version runs.
    expect(sites.hits.filter((hit) => hit.startsWith("jobs.localhost /search"))).toHaveLength(7);
  });

  it("a search without results is an empty list, not a broken recipe", async () => {
    await saveRecipe(boardRecipe());
    const { runId, status } = await run(SEARCH("cobol"));
    expect(status).toBe("DONE");
    expect(await output(runId, "search")).toEqual({ items: [], pages: 1 });
    expect((await db.client.siteRecipe.findFirstOrThrow()).brokenAt).toBeNull();
  });

  it('M18-I2: a recipe that finds only its "no results" page for a week is told once; finding items again clears it', async () => {
    const recipe = await saveRecipe(boardRecipe());
    const quiet = () => db.client.siteRecipe.findUniqueOrThrow({ where: { siteRecipeId: recipe.siteRecipeId } });
    // Found items 6 days ago: an empty search now is still news to nobody.
    await db.client.siteRecipe.update({ where: { siteRecipeId: recipe.siteRecipeId }, data: { lastItemsAt: new Date(Date.now() - 6 * 86_400_000) } });
    expect((await run(SEARCH("cobol"))).status).toBe("DONE");
    expect(notified).toEqual([]);

    // Eight days: told once, with the day it last found something; the next empty run says nothing new.
    const last = new Date(Date.now() - 8 * 86_400_000);
    await db.client.siteRecipe.update({ where: { siteRecipeId: recipe.siteRecipeId }, data: { lastItemsAt: last } });
    for (let i = 0; i < 2; i++) expect((await run(SEARCH("cobol"))).status).toBe("DONE");
    expect(notified).toEqual([
      `AI ME: recipe jobs.localhost/search has found nothing since ${last.toISOString().slice(0, 10)}: the site's "no results" page every time. ` +
        "If the site changed, teach it again on the Recipes page; if there's just nothing new, ignore this.",
    ]);
    expect(await quiet()).toMatchObject({ quietToldAt: expect.any(Date) as unknown, lastItemsAt: last, brokenAt: null });

    // Items again: no longer quiet, and a later quiet week is told again.
    expect((await run(SEARCH())).status).toBe("DONE");
    expect(await quiet()).toMatchObject({ quietToldAt: null, lastItemsAt: expect.any(Date) as unknown });
    expect((await quiet()).lastItemsAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(notified).toHaveLength(1);
  });

  it("M9-I2: a second run over the same list saves no new postings", async () => {
    await saveRecipe(boardRecipe());
    const first = await run(DAILY);
    expect(first.status).toBe("DONE");
    expect(await output(first.runId, "save")).toMatchObject({ saved: 12, created: 12, skipped: 0, changed: [], removed: [] });
    const saved = await db.client.jobPosting.findMany({ orderBy: { title: "asc" } });
    expect(saved).toHaveLength(12);
    expect(saved[0]).toMatchObject({ source: "jobs.localhost/search", status: "NEW", company: expect.any(String) as unknown });

    const second = await run(DAILY);
    expect(second.status).toBe("DONE");
    expect(await output(second.runId, "fresh")).toEqual({ items: [], duplicates: 12 });
    expect(await output(second.runId, "save")).toEqual({ saved: 0, created: 0, skipped: 0, added: [], changed: [], removed: [], invalid: [] });
    expect(await db.client.jobPosting.count()).toBe(12);
  });

  it("data.save moves a posting's status forward only, and a dry run saves nothing", async () => {
    const url = sites.url("jobs", "/jobs/100");
    await db.client.jobPosting.create({ data: { userId, source: "x", url, title: "Senior .NET Developer", status: "APPLIED" } });
    const source = (status: string) => `name: Save
steps:
  - id: save
    type: data.save
    with:
      status: ${status}
      items:
        - { url: "${url}", title: "Senior .NET Developer", score: 91, scoreReason: "Fits" }
        - { url: "${sites.url("jobs", "/jobs/101")}", title: "Mid .NET Engineer 1" }
        - { title: "no address" }
`;
    const dry = await runner.start(await createVersion(db.client, userId, source("SHORTLISTED")), { trigger: "manual", dryRun: true });
    expect(await runner.advance(dry)).toBe("DONE");
    expect(await output(dry, "save")).toMatchObject({ saved: 2, created: 1, skipped: 1 });
    expect(await db.client.jobPosting.count()).toBe(1);

    const { runId } = await run(source("SHORTLISTED"));
    expect(await output(runId, "save")).toMatchObject({ saved: 2, created: 1, skipped: 1 });
    expect(await db.client.jobPosting.findFirstOrThrow({ where: { url } })).toMatchObject({ status: "APPLIED", score: 91, scoreReason: "Fits" });
    expect(await db.client.jobPosting.findFirstOrThrow({ where: { title: "Mid .NET Engineer 1" } })).toMatchObject({ status: "SHORTLISTED" });

    await run(source("NEW"));
    expect(await db.client.jobPosting.findFirstOrThrow({ where: { title: "Mid .NET Engineer 1" } })).toMatchObject({ status: "SHORTLISTED" });
  });

  it("M9-I3: a redesigned page fails the step clearly, marks the recipe broken and tells me once", async () => {
    const recipe = await saveRecipe(boardRecipe());
    sites.redesignJobs();
    for (let i = 0; i < 2; i++) {
      const { runId, status } = await run(SEARCH("net", 5));
      expect(status).toBe("FAILED");
      const step = await db.client.step.findFirstOrThrow({ where: { runId, stepKey: "search" } });
      expect(step.error).toBe(
        `Recipe jobs.localhost/search v1 no longer matches the page: "article.job" matched nothing on ${sites.url("jobs", "/search?q=net")}`,
      );
      expect(await db.client.artifact.count({ where: { runId, kind: "screenshot" } })).toBe(1);
    }
    expect(await db.client.siteRecipe.findUniqueOrThrow({ where: { siteRecipeId: recipe.siteRecipeId } })).toMatchObject({
      brokenAt: expect.any(Date) as unknown,
      brokenReason: expect.stringContaining('"article.job" matched nothing') as unknown,
    });
    expect(notified).toEqual([expect.stringContaining("recipe jobs.localhost/search v1 is broken") as unknown]);

    sites.reset(); // the site is back (or a new version taught): it works and is no longer marked broken
    expect((await run(SEARCH())).status).toBe("DONE");
    expect((await db.client.siteRecipe.findUniqueOrThrow({ where: { siteRecipeId: recipe.siteRecipeId } })).brokenAt).toBeNull();
  });

  it("M11-I1: with fallback, the agent finds the moved list, a fix checked on the page is proposed, and the run reads with it", async () => {
    const recipe = await saveRecipe(boardRecipe());
    sites.redesignJobs();
    chat.play([click("link", /Browse jobs/), () => ({ name: "finish", input: { outcome: "done", answer: "The list shows" } })]);
    const fix = {
      url: sites.url("jobs", "/jobs?q={query}"),
      params: [{ name: "query", description: "what to search" }],
      item: "li.posting-card",
      fields: [
        { name: "url", selector: "h3 a", attr: "href", required: true },
        { name: "title", selector: "h3 a", required: true },
      ],
      key: "url",
      next: { kind: "link", selector: "a.next" },
      notes: "The list moved to /jobs",
    };
    llm = new ScriptedLlm([fix]);
    const source = SEARCH("net", 5).replace("      timeoutSeconds:", "      fallback: true\n      timeoutSeconds:");
    const { runId, status } = await run(source);
    expect(status).toBe("DONE");

    // Every posting, read with the fix across its pages.
    const { items } = await output(runId, "search");
    expect((items as { url: string }[]).map((i) => i.url)).toEqual(JOBS.map((job) => sites.url("jobs", `/jobs/${job.id}`)));
    // The agent brought the page to the list, on the board only; the writer saw the old version.
    expect(chat.results()[0]).toContain(`<page url="${sites.url("jobs", "/jobs?q=net")}"`);
    expect(llm.prompts[0]).toContain("Version 1 no longer matches the page");
    expect(sites.hits.every((hit) => hit.startsWith("jobs.localhost "))).toBe(true);

    // A proposal on the broken version, not a version: runs keep v1 until I approve it.
    const row = await db.client.siteRecipe.findUniqueOrThrow({ where: { siteRecipeId: recipe.siteRecipeId } });
    expect(row).toMatchObject({ brokenAt: expect.any(Date) as unknown, proposedInRunId: runId, proposed: expect.objectContaining({ item: "li.posting-card" }) as unknown });
    expect(await db.client.siteRecipe.count()).toBe(1);
    expect(notified).toEqual([expect.stringContaining("The agent found a fix: approve it on the Recipes page") as unknown]);

    // The next run reads with the waiting fix: no agent, no LLM.
    chat.play([]);
    llm = new ScriptedLlm([]);
    expect((await run(source)).status).toBe("DONE");
    expect(chat.requests).toHaveLength(0);
    expect(notified).toHaveLength(1);
  });

  it("a recipe that would leave its site, or no recipe at all, fails before opening anything", async () => {
    expect((await run(SEARCH())).status).toBe("FAILED");
    expect((await db.client.step.findFirstOrThrow()).error).toContain('There is no recipe "jobs.localhost/search" yet');
    await db.client.run.deleteMany();
    await saveRecipe({ ...boardRecipe(), url: sites.url("app", "/search?q={query}") });
    expect((await run(SEARCH())).status).toBe("FAILED");
    expect((await db.client.step.findFirstOrThrow()).error).toContain("is not on jobs.localhost");
    expect(sites.hits).toEqual([]);
  });

  describe("M9-T2: teach mode", () => {
    const TEACH = () => `name: Teach
steps:
  - id: teach
    type: browser.teach
    with:
      recipe: jobs.localhost/search
      url: "${sites.url("jobs", "/search?q=net")}"
      params: { query: net }
      fields: [url, title, company, location]
`;
    const proposal = (item: string) => ({
      url: sites.url("jobs", "/search?q={query}"),
      params: [{ name: "query", description: "what to search" }],
      item,
      fields: [
        { name: "url", selector: "a.job-title", attr: "href", required: true },
        { name: "title", selector: "a.job-title", required: true },
        { name: "company", selector: ".company", required: false },
        { name: "location", selector: ".location", required: false },
      ],
      key: "url",
      empty: ".no-results",
      next: { kind: "page", url: sites.url("jobs", "/search?q={query}&page={page}"), start: 2 },
      notes: "Cards are article.job.",
    });
    const continueTakeover = async (runId: string, reason: RegExp, status: "CONTINUED" | "ABORTED" = "CONTINUED") => {
      const takeover = await until(() => db.client.takeover.findFirst({ where: { runId, status: "OPEN" } }), "the takeover");
      expect(takeover.reason).toMatch(reason);
      await db.client.takeover.update({ where: { takeoverId: takeover.takeoverId }, data: { status, resolvedAt: new Date() } });
    };

    it("I show the list, the LLM's recipe is checked on the page and fixed, and Continue saves it as the next version", async () => {
      await saveRecipe(boardRecipe(), 1);
      llm = new ScriptedLlm([proposal(".card"), proposal("article.job")]);
      const runId = await runner.start(await createVersion(db.client, userId, TEACH()), { trigger: "manual" });
      const advancing = runner.advance(runId);

      await continueTakeover(runId, /^Teach jobs.localhost\/search: show the list to read/);
      await continueTakeover(runId, /^jobs.localhost\/search: 5 items read on this page \(outlined\).*Continue saves it as v2/);
      expect(await advancing).toBe("DONE");

      // The LLM read the page's outline; its first proposal matched nothing and went back with what failed.
      expect(llm.prompts).toHaveLength(2);
      expect(llm.prompts[0]).toContain('<article.job data-id="100">');
      expect(llm.prompts[0]).toContain('<a.job-title href="/jobs/100"> Senior .NET Developer');
      expect(llm.prompts[1]).toMatch(/<problems>[\s\S]*item ".card" matches nothing on this page/);
      // The page is the cached start of both asks: the retry pays a tenth for it.
      expect(llm.cached[0]).toContain('<article.job data-id="100">');
      expect(llm.cached[1]).toBe(llm.cached[0]);

      const saved = await db.client.siteRecipe.findFirstOrThrow({ where: { version: 2 } });
      expect(saved).toMatchObject({ name: "jobs.localhost/search", site: "jobs.localhost", taughtInRunId: runId });
      expect((saved.steps as Recipe).item).toBe("article.job");
      expect(await output(runId, "teach")).toMatchObject({ recipe: "jobs.localhost/search", version: 2, items: expect.any(Array) as unknown });
      expect(((await output(runId, "teach")).items as unknown[]).length).toBe(5);
      // The taught recipe reads the whole list.
      const { runId: searchRun } = await run(SEARCH());
      expect(((await output(searchRun, "search")).items as unknown[]).length).toBe(12);
    });

    it("a fix that fails the same way ends it, without the third call", async () => {
      llm = new ScriptedLlm([proposal(".card"), proposal(".card"), proposal("article.job")]);
      const runId = await runner.start(await createVersion(db.client, userId, TEACH()), { trigger: "manual" });
      const advancing = runner.advance(runId);
      await continueTakeover(runId, /show the list/);
      expect(await advancing).toBe("FAILED");
      expect(llm.prompts).toHaveLength(2);
      const step = await db.client.step.findFirstOrThrow({ where: { runId, stepKey: "teach" } });
      expect(step.error).toMatch(/the fix failed the same way \(item "\.card" matches nothing on this page\)/);
    });

    it("Abort discards the recipe", async () => {
      llm = new ScriptedLlm([proposal("article.job")]);
      const runId = await runner.start(await createVersion(db.client, userId, TEACH()), { trigger: "manual" });
      const advancing = runner.advance(runId);
      await continueTakeover(runId, /show the list/);
      await continueTakeover(runId, /Continue saves it as v1/, "ABORTED");
      expect(await advancing).toBe("ABORTED");
      expect(await db.client.siteRecipe.count()).toBe(0);
    });
  });
});

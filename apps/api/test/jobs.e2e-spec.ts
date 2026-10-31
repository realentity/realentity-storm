import { createPrismaConnection, type PrismaConnection } from "@ai-me/db";
import { type JobPostingView, type RecipeDetailView, type RecipeSummaryView, type TeachStartedView } from "@ai-me/shared";
import { TestEnvironment } from "@ai-me/testing";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

const RECIPE = `
url: https://dev.bg/company/jobs/{category}/
params: { category: { description: "a dev.bg category, e.g. net" } }
item: .job-list-item
fields:
  url: { selector: a.overlay-link, attr: href, required: true }
  title: { selector: .job-title, required: true }
  company: { selector: .company-name }
next: { kind: page, url: "https://dev.bg/company/jobs/{category}/?_paged={page}" }
`;

// M9-T3, T6, T7 (the api's part): the Jobs page, recipes and starting teach mode
describe("jobs and recipes", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;
  let userId: string;

  beforeAll(async () => {
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  afterEach(async () => {
    await db.client.jobPosting.deleteMany();
    await db.client.siteRecipe.deleteMany();
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  it("M9-T6: lists postings best first, filters them, and keeps my decision", async () => {
    const posting = (title: string, score: number | null, company = "Acme") =>
      db.client.jobPosting.create({ data: { userId, source: "dev.bg/search", url: `https://dev.bg/company/jobads/${title.replace(/\W+/g, "-")}/`, title, company, score } });
    await posting("Mid .NET Engineer", 64, "Beta");
    const best = await posting("Senior .NET Developer", 91);
    await posting("Not scored yet", null);

    const list = (query = "") => agent.get(`/api/jobs${query}`).expect(200).then((r) => (r.body as JobPostingView[]).map((j) => j.title));
    expect(await list()).toEqual(["Senior .NET Developer", "Mid .NET Engineer", "Not scored yet"]);
    expect(await list("?minScore=70")).toEqual(["Senior .NET Developer"]);
    expect(await list("?q=beta")).toEqual(["Mid .NET Engineer"]);

    const updated = (await agent.patch(`/api/jobs/${best.jobPostingId}`).send({ status: "SHORTLISTED" }).expect(200)).body as JobPostingView;
    expect(updated).toMatchObject({ status: "SHORTLISTED", score: 91, source: "dev.bg/search" });
    expect(await list("?status=SHORTLISTED")).toEqual(["Senior .NET Developer"]);
    await agent.patch(`/api/jobs/${best.jobPostingId}`).send({ status: "GONE" }).expect(400);
    await agent.patch("/api/jobs/00000000-0000-4000-8000-000000000000").send({ status: "SKIPPED" }).expect(404);
  });

  it("M9-T3: imports a recipe as the next version, checked like a taught one, and lists its health", async () => {
    await agent.post("/api/recipes").send({ name: "dev.bg/search", source: RECIPE }).expect(201);
    const second = (await agent.post("/api/recipes").send({ name: "dev.bg/search", source: RECIPE.replace("{page}", "{page}&x=1") }).expect(201))
      .body as RecipeDetailView;
    expect(second.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(second.versions[0]).toMatchObject({ taughtInRunId: null, brokenAt: null });

    // Off its site, not a recipe at all, a bad name.
    const offSite = await agent.post("/api/recipes").send({ name: "dev.bg/search", source: RECIPE.replace("https://dev.bg/company", "https://evil.example/company") }).expect(400);
    expect((offSite.body as { message: string }).message).toContain("is not on dev.bg");
    await agent.post("/api/recipes").send({ name: "dev.bg/search", source: "item: 3" }).expect(400);
    await agent.post("/api/recipes").send({ name: "dev.bg", source: RECIPE }).expect(400);

    await db.client.siteRecipe.updateMany({ where: { version: 2 }, data: { brokenAt: new Date(), brokenReason: '".job-list-item" matched nothing' } });
    const recipes = (await agent.get("/api/recipes").expect(200)).body as RecipeSummaryView[];
    expect(recipes).toEqual([
      expect.objectContaining({ name: "dev.bg/search", site: "dev.bg", version: 2, brokenReason: '".job-list-item" matched nothing' }),
    ]);
    expect(((await agent.get("/api/recipes/dev.bg/search").expect(200)).body as RecipeDetailView).versions).toHaveLength(2);
    await agent.get("/api/recipes/dev.bg/other").expect(404);
  });

  it("M9-T2: teach mode is a headed run of the recipe's Teach pipeline, reused next time", async () => {
    const body = { name: "dev.bg/search", url: "https://dev.bg/company/jobs/net/", params: { category: "net" } };
    const first = (await agent.post("/api/recipes/teach").send(body).expect(201)).body as TeachStartedView;
    const run = await db.client.run.findUniqueOrThrow({ where: { runId: first.runId }, include: { pipelineVersion: { include: { pipeline: true } } } });
    expect(run).toMatchObject({ headed: true, status: "QUEUED", trigger: "manual" });
    expect(run.pipelineVersion.pipeline.name).toBe("Teach dev.bg/search");
    expect(run.pipelineVersion.definition).toMatchObject({
      steps: [{ id: "teach", type: "browser.teach", with: { recipe: "dev.bg/search", url: body.url, params: { category: "net" } } }],
    });

    // The same again: the same pipeline and version; other inputs: its next version.
    const again = (await agent.post("/api/recipes/teach").send(body).expect(201)).body as TeachStartedView;
    expect(again.pipelineId).toBe(first.pipelineId);
    await agent.post("/api/recipes/teach").send({ ...body, hint: "skip the promoted cards" }).expect(201);
    expect(await db.client.pipelineVersion.count({ where: { pipelineId: first.pipelineId } })).toBe(2);
    expect(await db.client.pipeline.count()).toBe(1);

    await agent.post("/api/recipes/teach").send({ ...body, name: "not a name" }).expect(400);
    await agent.post("/api/recipes/teach").send({ ...body, url: "javascript:alert(1)" }).expect(400);
  });
});

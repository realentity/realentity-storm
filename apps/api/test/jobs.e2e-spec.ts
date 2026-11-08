import { createPrismaConnection, type Prisma, type PrismaConnection } from "@realentity/storm-db";
import { QUEUES } from "@realentity/storm-queue";
import { type ApplicationView, type InsightView, type JobPostingView, type RecipeDetailView, type RecipeSummaryView, type TeachStartedView } from "@realentity/storm-shared";
import { TestEnvironment } from "@realentity/storm-testing";
import type request from "supertest";
import { parse as parseYaml } from "yaml";
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
    // A pipeline pasted here by mistake says where it belongs.
    const pipeline = await agent
      .post("/api/recipes")
      .send({ name: "dev.bg/search", source: "name: Daily .NET jobs\nsteps:\n  - id: search\n    type: browser.extract\n" })
      .expect(400);
    expect((pipeline.body as { message: string }).message).toMatch(/^This is a pipeline \(it has steps\): paste it on Pipelines → New pipeline/);
    await agent.post("/api/recipes").send({ name: "dev.bg", source: RECIPE }).expect(400);

    await db.client.siteRecipe.updateMany({ where: { version: 2 }, data: { brokenAt: new Date(), brokenReason: '".job-list-item" matched nothing' } });
    const recipes = (await agent.get("/api/recipes").expect(200)).body as RecipeSummaryView[];
    expect(recipes).toEqual([
      expect.objectContaining({ name: "dev.bg/search", site: "dev.bg", version: 2, brokenReason: '".job-list-item" matched nothing' }),
    ]);
    expect(((await agent.get("/api/recipes/dev.bg/search").expect(200)).body as RecipeDetailView).versions).toHaveLength(2);
    await agent.get("/api/recipes/dev.bg/other").expect(404);
  });

  it("M11-T3: the agent's fix for a broken recipe is mine to approve (the next version) or discard", async () => {
    await agent.post("/api/recipes").send({ name: "dev.bg/search", source: RECIPE }).expect(201);
    await agent.post("/api/recipes/dev.bg/search/fix").expect(400);
    const fixed = parseYaml(RECIPE.replace("{page}", "{page}&fixed=1")) as Prisma.InputJsonValue;
    const propose = (version: number, proposed: Prisma.InputJsonValue) =>
      db.client.siteRecipe.updateMany({ where: { version }, data: { brokenAt: new Date(), brokenReason: "matched nothing", proposed, proposedAt: new Date() } });

    await propose(1, fixed);
    expect(((await agent.get("/api/recipes").expect(200)).body as RecipeSummaryView[])[0].proposedAt).toEqual(expect.any(String));
    const detail = (await agent.post("/api/recipes/dev.bg/search/fix").expect(200)).body as RecipeDetailView;
    expect(detail.versions.map((v) => [v.version, v.proposed])).toEqual([
      [2, null],
      [1, null],
    ]);
    expect(detail.versions[0].recipe).toMatchObject(fixed as object);

    // Discarded: no new version. A proposal that isn't a valid recipe is never saved.
    await propose(2, { url: "https://evil.example/" });
    await agent.post("/api/recipes/dev.bg/search/fix").expect(400);
    expect(((await agent.delete("/api/recipes/dev.bg/search/fix").expect(200)).body as RecipeDetailView).versions.map((v) => v.proposed)).toEqual([null, null]);
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
  // M16-I1: the dashboard's counts against known postings and applications.
  describe("M16: insight and outcomes", () => {
    const DAY = 86_400_000;
    /** A posting found `daysAgo`, scored, maybe applied to with outcome dates (days after applying). */
    interface PostingOptions {
      source?: string;
      score?: number | null;
      daysAgo?: number;
      status?: "NEW" | "SHORTLISTED" | "SKIPPED" | "APPLIED";
      applied?: { replied?: number; interview?: number; rejected?: number } | null;
    }
    async function posting(key: string, { source = "dev.bg/search", score = null, daysAgo = 5, status = "NEW", applied = null }: PostingOptions = {}) {
      const found = new Date(Date.now() - daysAgo * DAY);
      const job = await db.client.jobPosting.create({ data: { userId, source, url: `https://jobs.test/${key}`, title: key, company: key, score, status, firstSeenAt: found } });
      if (!applied) return job;
      const submittedAt = new Date(found.getTime() + DAY);
      const at = (days?: number) => (days === undefined ? null : new Date(submittedAt.getTime() + days * DAY));
      await db.client.application.create({
        data: {
          userId,
          jobPostingId: job.jobPostingId,
          status: applied.rejected !== undefined ? "REJECTED" : applied.interview !== undefined ? "INTERVIEW" : applied.replied !== undefined ? "RESPONDED" : "SUBMITTED",
          submittedAt,
          respondedAt: at(applied.replied),
          interviewAt: at(applied.interview),
          rejectedAt: at(applied.rejected),
        },
      });
      return job;
    }

    it("counts found, applied, replied, interviews and rejections, by source and score band; older postings left out", async () => {
      await posting("a", { score: 90, status: "APPLIED", applied: { interview: 4, rejected: 9 } });
      await posting("b", { score: 85, status: "APPLIED", applied: { replied: 2 } });
      await posting("c", { score: 70, status: "APPLIED", applied: {} });
      await posting("d", { score: 65, status: "SHORTLISTED" });
      await posting("e", { score: 30, status: "SKIPPED" });
      await posting("f", { source: "jobs.bg/search", status: "APPLIED", applied: { rejected: 6 } });
      await posting("old", { score: 95, daysAgo: 120, status: "APPLIED", applied: { interview: 1 } });

      const view = (await agent.get("/api/insight?days=90").expect(200)).body as InsightView;
      expect(view.totals).toEqual({ key: "all", found: 6, shortlisted: 5, applied: 4, replied: 3, interview: 1, rejected: 2, waiting: 1 });
      expect(view.bySource).toEqual([
        { key: "dev.bg/search", found: 5, shortlisted: 4, applied: 3, replied: 2, interview: 1, rejected: 1, waiting: 1 },
        { key: "jobs.bg/search", found: 1, shortlisted: 1, applied: 1, replied: 1, interview: 0, rejected: 1, waiting: 0 },
      ]);
      expect(view.byScore.map((r) => [r.key, r.found, r.applied, r.replied, r.interview])).toEqual([
        ["80–100", 2, 2, 2, 1],
        ["60–79", 2, 1, 0, 0],
        ["40–59", 0, 0, 0, 0],
        ["0–39", 1, 0, 0, 0],
        ["unscored", 1, 1, 1, 0],
      ]);
      // First answers 4, 2 and 6 days after applying.
      expect(view.medianDaysToAnswer).toBe(4);
      expect((await agent.get("/api/insight?days=365").expect(200)).body).toMatchObject({ totals: { found: 7, interview: 2 } });
      await agent.get("/api/insight?days=1").expect(400);
    });

    it("an outcome by hand: the status, its date the first time, a note; the pipelines are told", async () => {
      const job = await posting("acme", { status: "APPLIED", applied: {} });
      const { applicationId } = await db.client.application.findFirstOrThrow({ where: { jobPostingId: job.jobPostingId } });
      await db.client.$executeRaw`DELETE FROM pgboss.job WHERE name = ${QUEUES.events}`;

      const interview = (await agent.patch(`/api/applications/${applicationId}`).send({ status: "INTERVIEW", note: "phone call" }).expect(200)).body as ApplicationView;
      expect(interview).toMatchObject({ status: "INTERVIEW", interviewAt: expect.any(String) as unknown, rejectedAt: null });
      expect(interview.notes).toMatch(/^\d{4}-\d\d-\d\d interview \(by hand\): phone call$/);
      const events = await db.client.$queryRaw<{ data: Record<string, unknown> }[]>`SELECT data FROM pgboss.job WHERE name = ${QUEUES.events}`;
      expect(events.map((e) => e.data)).toEqual([
        expect.objectContaining({ event: "application.status", data: expect.objectContaining({ applicationId, status: "INTERVIEW" }) as unknown }),
      ]);
      // Undone by hand (a mistake): the interview's date stays, the Jobs page shows it.
      const back = (await agent.patch(`/api/applications/${applicationId}`).send({ status: "SUBMITTED" }).expect(200)).body as ApplicationView;
      expect(back).toMatchObject({ status: "SUBMITTED", interviewAt: interview.interviewAt });
      const listed = (await agent.get("/api/jobs").expect(200)).body as JobPostingView[];
      expect(listed[0].application).toMatchObject({ applicationId, status: "SUBMITTED", interviewAt: interview.interviewAt });
      await agent.patch(`/api/applications/${applicationId}`).send({ status: "PREPARED" }).expect(400);
    });
  });
});

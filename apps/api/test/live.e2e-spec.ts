import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { type LiveView, type RunDetailView } from "@realentity/storm-shared";
import { TestEnvironment } from "@realentity/storm-testing";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

const FULL = "full-ctl-7Hq2";
const VIEW = "view-only-9Kd4";

// M8-T3, T5, T8 and the api's part of M8-S5
describe("live view and takeover", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;
  let userId: string;
  let artifactsDir: string;
  let versionId: string;

  beforeAll(async () => {
    artifactsDir = await mkdtemp(join(tmpdir(), "storm-api-artifacts-"));
    process.env.ARTIFACTS_DIR = artifactsDir;
    process.env.VNC_PASSWORD = FULL;
    process.env.VNC_VIEW_PASSWORD = VIEW;
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    const pipeline = await db.client.pipeline.create({ data: { userId, name: "Account" } });
    versionId = (
      await db.client.pipelineVersion.create({
        data: { pipelineId: pipeline.pipelineId, version: 1, definition: { name: "Account", steps: [] }, policy: {}, savedAt: new Date() },
      })
    ).pipelineVersionId;
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
  });

  afterAll(async () => {
    await db.client.pipeline.deleteMany();
    await db.close();
    await api.close();
    for (const key of ["ARTIFACTS_DIR", "VNC_PASSWORD", "VNC_VIEW_PASSWORD"]) delete process.env[key];
    await rm(artifactsDir, { recursive: true, force: true });
  });

  const run = (status: "RUNNING" | "DONE" | "WAITING_FOR_USER", headed = true) =>
    db.client.run.create({ data: { userId, pipelineVersionId: versionId, trigger: "manual", status, headed } });
  const live = async (runId: string) => (await agent.get(`/api/runs/${runId}/live`).expect(200)).body as LiveView;

  it("M8-S5: the view-only password while the run works; the full one only while it waits for the user", async () => {
    const { runId } = await run("RUNNING");
    expect(await live(runId)).toEqual({
      available: true,
      active: true,
      path: "/vnc/",
      password: VIEW,
      control: false,
      window: { open: false, step: null, screenshotId: null },
    });

    await agent.post(`/api/runs/${runId}/takeover`).expect(204);
    expect(await live(runId)).toMatchObject({ password: FULL, control: true });
    const detail = (await agent.get(`/api/runs/${runId}`).expect(200)).body as RunDetailView;
    expect(detail).toMatchObject({ headed: true, takeover: { status: "TAKEN_OVER", reason: "Taken over" } });

    await agent.post(`/api/runs/${runId}/continue`).expect(204);
    expect(await live(runId)).toMatchObject({ password: VIEW, control: false });
    expect(await db.client.takeover.findFirstOrThrow({ where: { runId } })).toMatchObject({ status: "CONTINUED" });
    await agent.post(`/api/runs/${runId}/continue`).expect(409);

    // Nothing to watch: a finished run, a headless one.
    expect(await live((await run("DONE")).runId)).toMatchObject({ active: false, password: null });
    const headless = await run("RUNNING", false);
    expect(await live(headless.runId)).toMatchObject({ active: false, password: null });
    await agent.post(`/api/runs/${headless.runId}/takeover`).expect(409);
  });

  it("says whether a browser window is on the display: a headed step, or waiting for the user; else the latest screenshot", async () => {
    const pipeline = await db.client.pipeline.create({ data: { userId, name: "Watch" } });
    const steps = [
      { id: "search", type: "browser.extract", with: { recipes: ["jobs.bg/search"] } },
      { id: "look", type: "browser.open", with: { url: "https://jobs.bg/", headed: true } },
      { id: "quiet", type: "browser.open", with: { url: "https://jobs.bg/" } },
    ];
    const version = await db.client.pipelineVersion.create({
      data: { pipelineId: pipeline.pipelineId, version: 1, definition: { name: "Watch", steps }, policy: {}, savedAt: new Date() },
    });
    const { runId } = await db.client.run.create({ data: { userId, pipelineVersionId: version.pipelineVersionId, trigger: "manual", status: "RUNNING", headed: true } });
    const step = (stepKey: string, type: string) => db.client.step.create({ data: { runId, stepKey, type, status: "RUNNING", startedAt: new Date() } });
    const done = (stepKey: string) => db.client.step.updateMany({ where: { runId, stepKey }, data: { status: "DONE" } });

    // Between steps: no window, nothing to show yet.
    expect((await live(runId)).window).toEqual({ open: false, step: null, screenshotId: null });

    // A hidden-browser step: no window; its screenshot instead.
    await step("search", "browser.extract");
    const shot = await db.client.artifact.create({ data: { userId, runId, kind: "screenshot", stepKey: "search", path: `${runId}/s.png`, mime: "image/png" } });
    expect((await live(runId)).window).toEqual({ open: false, step: { stepKey: "search", type: "browser.extract" }, screenshotId: shot.artifactId });

    // headed: true draws on the display; the same step type without it doesn't.
    await done("search");
    await step("look", "browser.open");
    expect((await live(runId)).window).toMatchObject({ open: true, step: { stepKey: "look" } });
    await done("look");
    await step("quiet", "browser.open");
    expect((await live(runId)).window).toMatchObject({ open: false, step: { stepKey: "quiet" } });

    // Waiting for the user: the window is there, whatever the step.
    await db.client.takeover.create({ data: { runId, status: "OPEN", reason: "A CAPTCHA" } });
    expect((await live(runId)).window).toMatchObject({ open: true });
    await db.client.run.deleteMany();
    await db.client.pipeline.delete({ where: { pipelineId: pipeline.pipelineId } });
  });

  it("a run that needs the user is listed until they continue or abort it", async () => {
    const { runId } = await run("WAITING_FOR_USER");
    await db.client.takeover.create({ data: { runId, status: "OPEN", reason: "CAPTCHA", url: "https://jobs.example.org/login" } });
    expect((await agent.get("/api/takeovers").expect(200)).body).toEqual([
      expect.objectContaining({ runId, pipelineName: "Account", reason: "CAPTCHA", status: "OPEN" }),
    ]);
    await agent.post(`/api/runs/${runId}/abort`).expect(204);
    expect((await agent.get("/api/takeovers").expect(200)).body).toEqual([]);
    expect(await db.client.takeover.findFirstOrThrow({ where: { runId } })).toMatchObject({ status: "ABORTED" });
  });

  it("/vnc is let through only for a signed-in session (Caddy's forward_auth)", async () => {
    await agent.get("/api/live/authorize").expect(204);
    await request(api.http).get("/api/live/authorize").expect(401);
  });

  it("M8-T8: a run's screenshot is served to the user from the artifacts folder, and nothing outside it", async () => {
    const { runId } = await run("DONE");
    await mkdir(join(artifactsDir, runId), { recursive: true });
    await writeFile(join(artifactsDir, runId, "open-screenshot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const shot = await db.client.artifact.create({
      data: { userId, runId, kind: "screenshot", stepKey: "open", path: `${runId}/open-screenshot.png`, mime: "image/png", size: 4 },
    });
    const outside = await db.client.artifact.create({
      data: { userId, runId, kind: "trace", path: "../secret.zip", mime: "application/zip" },
    });

    const response = await agent.get(`/api/artifacts/${shot.artifactId}`).expect(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["content-security-policy"]).toBe("sandbox");
    expect((await agent.get(`/api/runs/${runId}`).expect(200)).body).toMatchObject({
      artifacts: [expect.objectContaining({ kind: "screenshot", stepKey: "open" }), expect.objectContaining({ kind: "trace" })],
    });
    await agent.get(`/api/artifacts/${outside.artifactId}`).expect(404);
  });
});

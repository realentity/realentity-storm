import { createPrismaConnection, type PrismaConnection } from "@ai-me/db";
import { type AppDetailView, type PipelineDetailView } from "@ai-me/shared";
import { TestEnvironment } from "@ai-me/testing";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

const APP = (buttons = false) => `name: Shelf
types:
  Book:
    key: isbn
    fields:
      isbn: { type: text, required: true }
      title: { type: text }
${buttons ? "pages:\n  - list: Book\n    actions:\n      - { label: Fetch, run: Books in }\n" : ""}`;

const SAVER = `name: Books in
app: Shelf
steps:
  - id: save
    type: data.save
    with:
      type: Book
      items:
        - { isbn: "978-0", title: Dune }
`;

// Deleting an App or a pipeline (on the server, 2026-11-08: test Apps couldn't be removed)
describe("deleting Apps and pipelines", () => {
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
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.app.deleteMany();
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  it("a pipeline goes with its versions and runs; refused while a run is going or a button starts it", async () => {
    const app = (await agent.post("/api/apps").send({ source: APP() }).expect(201)).body as AppDetailView;
    const pipeline = (await agent.post("/api/pipelines").send({ source: SAVER }).expect(201)).body as PipelineDetailView;
    const versionId = pipeline.current!.pipelineVersionId;
    const run = (status: "DONE" | "RUNNING") =>
      db.client.run.create({ data: { userId, pipelineVersionId: versionId, status, trigger: "manual" } });
    const done = await run("DONE");
    await db.client.step.create({ data: { runId: done.runId, stepKey: "save", type: "data.save", status: "DONE" } });

    // A run still going: refused.
    const going = await run("RUNNING");
    const refused = await agent.delete(`/api/pipelines/${pipeline.pipelineId}`).expect(409);
    expect((refused.body as { message: string }).message).toBe('A run of "Books in" is still going: stop it or let it finish first');
    await db.client.run.update({ where: { runId: going.runId }, data: { status: "FAILED" } });

    // A button of the App starts it: refused, saying which.
    await agent
      .put(`/api/apps/${app.appId}`)
      .send({ source: APP(true) })
      .expect(200);
    const started = await agent.delete(`/api/pipelines/${pipeline.pipelineId}`).expect(409);
    expect((started.body as { message: string }).message).toBe('a button of "Shelf" starts "Books in": change it first');
    await agent.put(`/api/apps/${app.appId}`).send({ source: APP() }).expect(200);

    await agent.delete(`/api/pipelines/${pipeline.pipelineId}`).expect(204);
    expect(await db.client.pipeline.count({ where: { pipelineId: pipeline.pipelineId } })).toBe(0);
    expect(await db.client.pipelineVersion.count({ where: { pipelineId: pipeline.pipelineId } })).toBe(0);
    expect(await db.client.run.count({ where: { pipelineVersionId: versionId } })).toBe(0);
    expect(await db.client.step.count({ where: { runId: done.runId } })).toBe(0);
    await agent.delete(`/api/pipelines/${pipeline.pipelineId}`).expect(404);
  });

  it("an App goes with its versions and entities; refused while pipelines belong to it", async () => {
    const app = (await agent.post("/api/apps").send({ source: APP() }).expect(201)).body as AppDetailView;
    const pipeline = (await agent.post("/api/pipelines").send({ source: SAVER }).expect(201)).body as PipelineDetailView;
    await db.client.dataEntity.create({ data: { appId: app.appId, type: "Book", key: "978-0", value: { isbn: "978-0" } } });

    const refused = await agent.delete(`/api/apps/${app.appId}`).expect(409);
    expect((refused.body as { message: string }).message).toBe('"Books in" belongs to "Shelf": delete or move it first');

    await agent.delete(`/api/pipelines/${pipeline.pipelineId}`).expect(204);
    await agent.delete(`/api/apps/${app.appId}`).expect(204);
    expect(await db.client.app.count()).toBe(0);
    expect(await db.client.appVersion.count({ where: { appId: app.appId } })).toBe(0);
    expect(await db.client.dataEntity.count({ where: { appId: app.appId } })).toBe(0);
    await agent.get(`/api/apps/${app.appId}`).expect(404);
  });
});

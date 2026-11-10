import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { type TopicUpkeepView, type TopicView } from "@realentity/storm-shared";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

const UPKEEP = readFileSync(join(__dirname, "../../../pipelines/topic-upkeep.yaml"), "utf8");

// M42: the Topics page's card: is a pipeline keeping the topics' memory up to date, and what does it still need
describe("topic upkeep", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;

  beforeAll(async () => {
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.topic.deleteMany();
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  const status = async () => (await agent.get("/api/topics/upkeep").expect(200)).body as TopicUpkeepView;

  it("none until the shipped pipeline is installed (off); then it is found, and its topics counted", async () => {
    expect(await status()).toMatchObject({ pipeline: null, tried: false, lastRun: null, waiting: 0, topicsWithDirections: 0 });

    // Another pipeline isn't one.
    await agent
      .post("/api/pipelines")
      .send({ source: "name: Other\nsteps:\n  - id: t\n    type: notify.telegram\n    with: { text: hi }\n" })
      .expect(201);
    expect((await status()).pipeline).toBeNull();

    const { pipelineId } = (await agent.post("/api/pipelines").send({ source: UPKEEP }).expect(201)).body as { pipelineId: string };
    expect(await status()).toMatchObject({ pipeline: { pipelineId, name: "Topic upkeep", enabled: false }, tried: false });

    const topic = (await agent.post("/api/topics").send({ name: "Orion" }).expect(201)).body as TopicView;
    expect((await status()).topicsWithDirections).toBe(0);
    await agent.post(`/api/topics/${topic.topicId}/directions`).send({ kind: "DOMAIN", value: "client.example" }).expect(201);
    expect((await status()).topicsWithDirections).toBe(1);
  });
});

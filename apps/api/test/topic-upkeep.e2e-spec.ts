import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { type TopicUpkeepView, type TopicView } from "@realentity/storm-shared";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

const UPKEEP = readFileSync(join(__dirname, "../../../pipelines/topic-upkeep.yaml"), "utf8");
const TOPIC_REPLIES = readFileSync(join(__dirname, "../../../pipelines/topic-replies.yaml"), "utf8");
const TIDY = readFileSync(join(__dirname, "../../../pipelines/topic-tidy.yaml"), "utf8");
const RECRUITER_REPLIES = readFileSync(join(__dirname, "../../../pipelines/recruiter-replies.yaml"), "utf8");

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

  // M44: the second card: is a pipeline answering the topics' email
  it("Topic replies: recognized by what it drafts (the emails a topic took); upkeep and Recruiter replies aren't it", async () => {
    const replies = async () => (await agent.get("/api/topics/replies").expect(200)).body as TopicUpkeepView;
    expect((await replies()).pipeline).toBeNull();
    await agent.post("/api/pipelines").send({ source: UPKEEP }).expect(201);
    // It drafts for the emails no topic took.
    await agent.post("/api/pipelines").send({ source: RECRUITER_REPLIES }).expect(201);
    expect((await replies()).pipeline).toBeNull();

    const { pipelineId } = (await agent.post("/api/pipelines").send({ source: TOPIC_REPLIES }).expect(201)).body as { pipelineId: string };
    expect(await replies()).toMatchObject({ pipeline: { pipelineId, name: "Topic replies", enabled: false }, tried: false });
    expect((await status()).pipeline?.name).toBe("Topic upkeep");
  });

  // M44-T8: the third card: is a pipeline tidying the topics' facts, and how many topics have more than fit
  it("Topic tidy-up: recognized by topic.tidy; the topics with more facts than a draft has room for counted, on the list too", async () => {
    const tidy = async () => (await agent.get("/api/topics/tidy").expect(200)).body as TopicUpkeepView;
    expect(await tidy()).toMatchObject({ pipeline: null, topicsOverRoom: 0 });
    await agent.post("/api/pipelines").send({ source: UPKEEP }).expect(201);
    expect((await tidy()).pipeline).toBeNull();
    const { pipelineId } = (await agent.post("/api/pipelines").send({ source: TIDY }).expect(201)).body as { pipelineId: string };
    expect((await tidy()).pipeline).toMatchObject({ pipelineId, name: "Topic tidy-up", enabled: false });

    const topic = (await agent.post("/api/topics").send({ name: "Orion" }).expect(201)).body as TopicView;
    expect(topic.counts).toEqual({ facts: 0, fit: 0, disputed: 0, sources: 0, emails: 0 });
    for (let i = 0; i < 8; i++) {
      await agent
        .post(`/api/topics/${topic.topicId}/facts`)
        .send({ about: `Note ${i}`, statement: "Routine detail of the weekly meeting. ".repeat(23).trim() })
        .expect(201);
    }
    expect((await tidy()).topicsOverRoom).toBe(1);
    const [listed] = (await agent.get("/api/topics").expect(200)).body as TopicView[];
    expect(listed?.counts).toEqual({ facts: 8, fit: 6, disputed: 0, sources: 0, emails: 0 });
    expect(((await agent.get(`/api/topics/${topic.topicId}`).expect(200)).body as TopicView).counts.facts).toBe(8);
    // Archived, it isn't tidied.
    await agent.put(`/api/topics/${topic.topicId}`).send({ name: "Orion", description: "", status: "ARCHIVED" }).expect(200);
    expect((await tidy()).topicsOverRoom).toBe(0);
  });
});

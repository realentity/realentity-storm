import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { type TopicChangeView, type TopicFactView, type TopicView } from "@realentity/storm-shared";
import { TestEnvironment } from "@realentity/storm-testing";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

// M44-T4: a topic split or merged, as one change that can be undone
describe("topics split and merged", () => {
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
    await db.client.topic.deleteMany();
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  const topic = async (name: string) => (await agent.post("/api/topics").send({ name }).expect(201)).body as TopicView;
  const fact = async (topicId: string, about: string, statement: string) =>
    (await agent.post(`/api/topics/${topicId}/facts`).send({ about, statement }).expect(201)).body as TopicFactView;
  const facts = async (topicId: string) =>
    ((await agent.get(`/api/topics/${topicId}/facts`).expect(200)).body as TopicFactView[]).map((f) => [f.about, f.statement, f.status]);
  const link = (topicId: string, messageId: string) =>
    db.client.topicLink.create({
      data: {
        userId,
        topicId,
        messageId,
        threadId: messageId,
        from: "ivan@client.example",
        subject: "Invoice",
        date: new Date(),
        status: "CONFIRMED",
        via: "USER",
        evidence: "you",
      },
    });
  const undoLatest = async (topicId: string) => {
    const latest = ((await agent.get(`/api/topics/${topicId}/changes`).expect(200)).body as TopicChangeView[]).find((c) => !c.undone)!;
    await agent.post(`/api/topic-changes/${latest.topicChangeId}/undo`).expect(204);
  };

  // M44-I1
  it("a split moves the chosen facts, directions, sources and emails to a new topic; undo brings them back", async () => {
    const orion = await topic("Orion");
    const launch = await fact(orion.topicId, "Launch date", "March");
    const invoice = await fact(orion.topicId, "Invoice terms", "30 days");
    const withDirections = (
      await agent
        .post(`/api/topics/${orion.topicId}/directions`)
        .send({ kind: "PERSON", value: "ivan@client.example", about: "invoices" })
        .expect(201)
    ).body as TopicView;
    const source = await db.client.topicSource.create({
      data: { userId, topicId: orion.topicId, kind: "GITHUB", location: "acme/billing", path: "docs/**" },
    });
    await db.client.topicPassage.create({
      data: {
        userId,
        topicId: orion.topicId,
        topicSourceId: source.topicSourceId,
        path: "docs/terms.md",
        ref: "abc",
        refDate: new Date(),
        ordinal: 0,
        text: "Net 30.",
      },
    });
    const email = await link(orion.topicId, "<inv@client.example>");
    await link(orion.topicId, "<kickoff@client.example>");
    await agent
      .post(`/api/topics/${orion.topicId}/split`)
      .send({ name: "Orion", facts: [invoice.topicFactId] })
      .expect(409);
    await agent.post(`/api/topics/${orion.topicId}/split`).send({ name: "Billing" }).expect(400);

    const { topicId: billing } = (
      await agent
        .post(`/api/topics/${orion.topicId}/split`)
        .send({
          name: "Billing",
          description: "Invoices of Client Ltd",
          facts: [invoice.topicFactId],
          directions: [withDirections.directions[0].topicDirectionId],
          sources: [source.topicSourceId],
          links: [email.topicLinkId],
        })
        .expect(201)
    ).body as { topicId: string };
    expect(await facts(orion.topicId)).toEqual([["Launch date", "March", "CURRENT"]]);
    expect(await facts(billing)).toEqual([["Invoice terms", "30 days", "CURRENT"]]);
    expect(((await agent.get(`/api/topics/${billing}`).expect(200)).body as TopicView).directions.map((d) => d.value)).toEqual([
      "ivan@client.example",
    ]);
    expect(await db.client.topicPassage.findFirstOrThrow({ where: { topicSourceId: source.topicSourceId } })).toMatchObject({
      topicId: billing,
    });
    expect(await db.client.topicLink.count({ where: { topicId: billing } })).toBe(1);
    // The split shows in both topics' history.
    expect(((await agent.get(`/api/topics/${billing}/changes`).expect(200)).body as TopicChangeView[]).map((c) => c.kind)).toEqual([
      "SPLIT",
    ]);

    await undoLatest(orion.topicId);
    expect(await facts(orion.topicId)).toEqual([
      ["Invoice terms", "30 days", "CURRENT"],
      ["Launch date", "March", "CURRENT"],
    ]);
    expect(await db.client.topicLink.count({ where: { topicId: orion.topicId } })).toBe(2);
    expect(await db.client.topicPassage.findFirstOrThrow({ where: { topicSourceId: source.topicSourceId } })).toMatchObject({
      topicId: orion.topicId,
    });
    // Nothing left in the topic the split made: it goes.
    await agent.get(`/api/topics/${billing}`).expect(404);
    expect(launch.topicId).toBe(orion.topicId);
  });

  // M44-I2
  it("a merge raises the facts the two topics disagree on as conflicts; the merged one is archived; undo brings it back", async () => {
    const orion = await topic("Orion");
    const portal = await topic("Portal");
    await fact(orion.topicId, "Database", "PostgreSQL");
    await fact(orion.topicId, "Launch date", "March");
    await fact(portal.topicId, "database", "MySQL");
    await fact(portal.topicId, "Launch date", "March");
    await fact(portal.topicId, "Hosting", "The client's cloud");
    await link(orion.topicId, "<same@client.example>");
    await link(portal.topicId, "<same@client.example>");
    await link(portal.topicId, "<other@client.example>");

    const merged = (await agent.post(`/api/topics/${portal.topicId}/merge`).send({ into: orion.topicId }).expect(200)).body as {
      disputed: number;
    };
    expect(merged).toEqual({ disputed: 1 });
    expect(await facts(orion.topicId)).toEqual([
      ["database", "MySQL", "DISPUTED"],
      ["Database", "PostgreSQL", "DISPUTED"],
      ["Hosting", "The client's cloud", "CURRENT"],
      ["Launch date", "March", "CURRENT"],
      ["Launch date", "March", "SUPERSEDED"],
    ]);
    expect(((await agent.get(`/api/topics/${portal.topicId}`).expect(200)).body as TopicView).status).toBe("ARCHIVED");
    // The email both had stays once in each; the other one moved.
    expect(await db.client.topicLink.count({ where: { topicId: orion.topicId } })).toBe(2);
    const [change] = (await agent.get(`/api/topics/${orion.topicId}/changes`).expect(200)).body as TopicChangeView[];
    expect(change).toMatchObject({ kind: "MERGE", summary: "Merged Portal into Orion: 1 fact in dispute" });

    await undoLatest(orion.topicId);
    expect(await facts(orion.topicId)).toEqual([
      ["Database", "PostgreSQL", "CURRENT"],
      ["Launch date", "March", "CURRENT"],
    ]);
    expect(await facts(portal.topicId)).toEqual([
      ["database", "MySQL", "CURRENT"],
      ["Hosting", "The client's cloud", "CURRENT"],
      ["Launch date", "March", "CURRENT"],
    ]);
    expect(((await agent.get(`/api/topics/${portal.topicId}`).expect(200)).body as TopicView).status).toBe("ACTIVE");
    await agent.post(`/api/topics/${orion.topicId}/merge`).send({ into: orion.topicId }).expect(400);
  });
});

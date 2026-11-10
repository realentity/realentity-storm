import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { type TopicSuggestionView, type TopicView } from "@realentity/storm-shared";
import { TestEnvironment } from "@realentity/storm-testing";
import { randomUUID } from "node:crypto";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

// M44-T1: directions suggested from the user's own decisions, never active before they accept
describe("topic suggestions", () => {
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
  const decided = (topicId: string, from: string, count: number, status: "CONFIRMED" | "REJECTED" = "CONFIRMED") =>
    db.client.topicLink.createMany({
      data: Array.from({ length: count }, () => ({
        userId,
        topicId,
        messageId: `<${randomUUID()}@x.test>`,
        threadId: "t",
        from,
        subject: "s",
        date: new Date(),
        status,
        via: "USER" as const,
        evidence: "you",
      })),
    });
  const open = async () => (await agent.get("/api/topic-suggestions").expect(200)).body as TopicSuggestionView[];
  const shown = async () =>
    (await open()).map((s) => [s.topicName, (s.payload as { kind: string }).kind, (s.payload as { value: string }).value]);

  it("a person, a domain's people, never a free mail domain; none for a sender rejected or confirmed elsewhere", async () => {
    const billing = await topic("Billing");
    const orion = await topic("Orion");
    await decided(billing.topicId, "Ivan@Client.example", 3); // a person
    await decided(billing.topicId, "ana@acme.example", 2); // two people at a domain, four emails
    await decided(billing.topicId, "bob@acme.example", 2);
    await decided(billing.topicId, "cat@gmail.com", 3); // free mail: the person, not the domain
    await decided(billing.topicId, "dan@gmail.com", 2);
    await decided(billing.topicId, "eve@other.example", 3); // also rejected once
    await decided(billing.topicId, "eve@other.example", 1, "REJECTED");
    await decided(billing.topicId, "fay@both.example", 3); // confirmed for Orion too
    await decided(orion.topicId, "fay@both.example", 1);
    await decided(billing.topicId, "gus@few.example", 2); // too few

    expect(await shown()).toEqual(
      expect.arrayContaining([
        ["Billing", "DOMAIN", "acme.example"],
        ["Billing", "PERSON", "ivan@client.example"],
        ["Billing", "PERSON", "cat@gmail.com"],
      ]),
    );
    expect(await open()).toHaveLength(3);
    expect((await open()).find((s) => (s.payload as { value: string }).value === "acme.example")?.reason).toBe(
      "you confirmed 4 emails from 2 people at acme.example for Billing",
    );
  });

  it("accepted, the direction is added; dismissed, it isn't suggested again; a covered sender isn't suggested", async () => {
    const billing = await topic("Billing");
    await agent.post(`/api/topics/${billing.topicId}/directions`).send({ kind: "DOMAIN", value: "client.example" }).expect(201);
    await decided(billing.topicId, "ivan@client.example", 3); // covered by the domain
    await decided(billing.topicId, "ana@one.example", 3);
    await decided(billing.topicId, "bob@two.example", 3);
    const [first, second] = await open();
    expect(await open()).toHaveLength(2);

    await agent.post(`/api/topic-suggestions/${first.topicSuggestionId}/accept`).expect(200);
    const directions = ((await agent.get(`/api/topics/${billing.topicId}`).expect(200)).body as TopicView).directions;
    expect(directions.map((d) => [d.kind, d.value])).toContainEqual(["PERSON", (first.payload as { value: string }).value]);

    await agent.post(`/api/topic-suggestions/${second.topicSuggestionId}/dismiss`).expect(200);
    await decided(billing.topicId, (second.payload as { value: string }).value, 2);
    expect(await open()).toEqual([]);
    await agent.post(`/api/topic-suggestions/${second.topicSuggestionId}/accept`).expect(409);
  });
  // M44-T5
  it("a topic's cost: its upkeep's share and its backfills, the last 30 days", async () => {
    const orion = await topic("Orion");
    const day = (daysAgo: number) => {
      const d = new Date(Date.now() - daysAgo * 86_400_000);
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    };
    await db.client.topicCost.createMany({
      data: [
        { userId, topicId: orion.topicId, day: day(1), source: "topic.extract", costUsd: 0.25 },
        { userId, topicId: orion.topicId, day: day(2), source: "topic.match", costUsd: 0.05 },
        { userId, topicId: orion.topicId, day: day(45), source: "topic.extract", costUsd: 9 },
      ],
    });
    await db.client.topicBackfill.create({
      data: { userId, topicId: orion.topicId, months: 3, status: "DONE", llmUsage: { costUsd: 0.2 } },
    });
    const listed = ((await agent.get("/api/topics").expect(200)).body as TopicView[]).find((t) => t.topicId === orion.topicId);
    expect(listed?.costUsd30).toBeCloseTo(0.5, 6);
    expect(((await agent.get(`/api/topics/${orion.topicId}`).expect(200)).body as TopicView).costUsd30).toBeCloseTo(0.5, 6);
  });
});

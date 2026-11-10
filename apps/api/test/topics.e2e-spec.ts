import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { type TopicLinkView, type TopicView } from "@realentity/storm-shared";
import { TestEnvironment } from "@realentity/storm-testing";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

// M41-T2: topics and their directions, written by the user only
describe("topics", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;

  beforeAll(async () => {
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
  });

  afterEach(async () => {
    await db.client.topic.deleteMany();
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  const create = async (name: string, description = "") =>
    (await agent.post("/api/topics").send({ name, description }).expect(201)).body as TopicView;

  it("makes, renames, describes and archives a topic; names are unique in any case", async () => {
    const orion = await create("Orion", "The customer portal rebuild for Client Ltd");
    expect(orion).toMatchObject({
      name: "Orion",
      description: "The customer portal rebuild for Client Ltd",
      status: "ACTIVE",
      directions: [],
    });
    await agent.post("/api/topics").send({ name: "orion" }).expect(409);
    await agent.post("/api/topics").send({ name: "  " }).expect(400);

    const billing = await create("Billing");
    await agent.put(`/api/topics/${billing.topicId}`).send({ name: "ORION", description: "", status: "ACTIVE" }).expect(409);
    const archived = (
      await agent.put(`/api/topics/${orion.topicId}`).send({ name: "Orion", description: "Done", status: "ARCHIVED" }).expect(200)
    ).body as TopicView;
    expect(archived).toMatchObject({ status: "ARCHIVED", description: "Done" });

    // Active first, then by name.
    expect(((await agent.get("/api/topics").expect(200)).body as TopicView[]).map((t) => t.name)).toEqual(["Billing", "Orion"]);

    await agent.delete(`/api/topics/${billing.topicId}`).expect(204);
    await agent.get(`/api/topics/${billing.topicId}`).expect(404);
  });

  it("directions: each kind checked and stored normalized, a duplicate refused, one removed", async () => {
    const { topicId } = await create("Orion");
    const add = (body: Record<string, unknown>) => agent.post(`/api/topics/${topicId}/directions`).send(body);

    await add({ kind: "WORD", value: "  Orion " }).expect(201);
    await add({ kind: "DOMAIN", value: "@Client.Example" }).expect(201);
    await add({ kind: "PERSON", value: "Ivan@Client.Example", about: " the API " }).expect(201);
    const last = (await add({ kind: "TEXT", value: "emails about the payment integration" }).expect(201)).body as TopicView;
    expect(last.directions.map((d) => [d.kind, d.value, d.about])).toEqual([
      ["WORD", "Orion", null],
      ["DOMAIN", "client.example", null],
      ["PERSON", "ivan@client.example", "the API"],
      ["TEXT", "emails about the payment integration", null],
    ]);

    await add({ kind: "DOMAIN", value: "CLIENT.example" }).expect(409);
    await add({ kind: "DOMAIN", value: "not a domain" }).expect(400);
    await add({ kind: "PERSON", value: "ivan" }).expect(400);
    await add({ kind: "WORD", value: "x" }).expect(400);
    await add({ kind: "WORD", value: "Orion", about: "the API" }).expect(400);
    await add({ kind: "SOURCE", value: "x" }).expect(400);

    const word = last.directions[0];
    const after = (await agent.delete(`/api/topics/${topicId}/directions/${word.topicDirectionId}`).expect(200)).body as TopicView;
    expect(after.directions.map((d) => d.kind)).toEqual(["DOMAIN", "PERSON", "TEXT"]);
    await agent.delete(`/api/topics/${topicId}/directions/${word.topicDirectionId}`).expect(404);
  });

  // M41-T4
  it("the queue: a suggested link confirmed, one rejected, one moved to another topic; a topic's emails", async () => {
    const userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    const orion = await create("Orion");
    const billing = await create("Billing");
    const link = (topicId: string, messageId: string, subject: string, status: "LINKED" | "SUGGESTED", day: number) =>
      db.client.topicLink.create({
        data: {
          userId,
          topicId,
          messageId,
          threadId: messageId,
          from: "ivan@client.example",
          subject,
          date: new Date(Date.UTC(2026, 10, day)),
          status,
          via: status === "LINKED" ? "DIRECTION" : "LLM",
          evidence: status === "LINKED" ? 'the word "Orion"' : "about the invoice",
        },
      });
    await link(orion.topicId, "<a@x.test>", "Kickoff", "LINKED", 1);
    const b = await link(orion.topicId, "<b@x.test>", "Invoice 42", "SUGGESTED", 2);
    const c = await link(billing.topicId, "<c@x.test>", "Contract", "SUGGESTED", 3);
    const d = await link(orion.topicId, "<d@x.test>", "Lunch", "SUGGESTED", 4);

    const waiting = (await agent.get("/api/topic-links/waiting").expect(200)).body as TopicLinkView[];
    expect(waiting.map((l) => [l.subject, l.topicName, l.evidence])).toEqual([
      ["Lunch", "Orion", "about the invoice"],
      ["Contract", "Billing", "about the invoice"],
      ["Invoice 42", "Orion", "about the invoice"],
    ]);

    await agent.post(`/api/topic-links/${c.topicLinkId}/confirm`).expect(200);
    await agent.post(`/api/topic-links/${d.topicLinkId}/reject`).expect(200);
    const moved = (await agent.post(`/api/topic-links/${b.topicLinkId}/move`).send({ topicId: billing.topicId }).expect(200))
      .body as TopicLinkView;
    expect(moved).toMatchObject({
      topicName: "Billing",
      subject: "Invoice 42",
      status: "CONFIRMED",
      via: "USER",
      evidence: "moved here from Orion by you",
    });
    await agent.post(`/api/topic-links/${b.topicLinkId}/move`).send({ topicId: orion.topicId }).expect(400);
    expect((await agent.get("/api/topic-links/waiting").expect(200)).body).toEqual([]);

    const ofOrion = (await agent.get(`/api/topics/${orion.topicId}/links`).expect(200)).body as TopicLinkView[];
    expect(ofOrion.map((l) => [l.subject, l.status])).toEqual([["Kickoff", "LINKED"]]);
    const ofBilling = (await agent.get(`/api/topics/${billing.topicId}/links`).expect(200)).body as TopicLinkView[];
    expect(ofBilling.map((l) => [l.subject, l.status])).toEqual([
      ["Contract", "CONFIRMED"],
      ["Invoice 42", "CONFIRMED"],
    ]);
    await agent.post(`/api/topic-links/${c.topicLinkId}/move`).send({ topicId: "00000000-0000-4000-8000-000000000000" }).expect(404);
  });
});

import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { type TopicChangeView, type TopicFactView, type TopicLinkView, type TopicView } from "@realentity/storm-shared";
import { TestEnvironment } from "@realentity/storm-testing";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

// M42-T1: a topic's facts, changed only by the user (or a proposal they approved), each change undoable
describe("topic facts", () => {
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
  const facts = async (topicId: string) => (await agent.get(`/api/topics/${topicId}/facts`).expect(200)).body as TopicFactView[];
  const changes = async (topicId: string) => (await agent.get(`/api/topics/${topicId}/changes`).expect(200)).body as TopicChangeView[];
  const undoLatest = async (topicId: string) => {
    const latest = (await changes(topicId)).find((c) => !c.undone)!;
    await agent.post(`/api/topic-changes/${latest.topicChangeId}/undo`).expect(204);
    return latest;
  };
  const shown = async (topicId: string) => (await facts(topicId)).map((f) => [f.about, f.statement, f.status]);
  /** A fact read from an email (what topic.apply writes after the gate). */
  const fromEmail = (topicId: string, about: string, statement: string, messageId: string) =>
    db.client.topicFact.create({
      data: {
        userId,
        topicId,
        about,
        statement,
        source: "EMAIL",
        sourceId: messageId,
        sourceLabel: "Maria <maria@client.example>: Kickoff",
        sourceDate: new Date("2026-11-02T09:00:00Z"),
        quote: `${about}: ${statement}`,
      },
    });

  it("the user writes, edits and corrects facts; each change says why and is listed", async () => {
    const { topicId } = await topic("Orion");
    const add = (body: Record<string, unknown>) => agent.post(`/api/topics/${topicId}/facts`).send(body);
    const launch = (await add({ about: "Launch date", statement: "February" }).expect(201)).body as TopicFactView;
    expect(launch).toMatchObject({ source: "USER", sourceLabel: "you", status: "CURRENT", pinned: true });
    await add({ about: "", statement: "x" }).expect(400);
    // A secret is a credential, never a fact.
    const secret = await add({ about: "Staging", statement: "password: hunter2-staging" }).expect(400);
    expect(JSON.stringify(secret.body)).not.toContain("hunter2");

    await agent.put(`/api/topic-facts/${launch.topicFactId}`).send({ about: "Launch", statement: "February" }).expect(200);
    const march = (await agent.post(`/api/topic-facts/${launch.topicFactId}/no-longer-true`).send({ statement: "March" }).expect(200))
      .body as TopicFactView;
    expect(await shown(topicId)).toEqual([
      ["Launch", "March", "CURRENT"],
      ["Launch", "February", "SUPERSEDED"],
    ]);
    expect((await facts(topicId))[1]?.supersededById).toBe(march.topicFactId);
    expect((await changes(topicId)).map((c) => [c.kind, c.summary])).toEqual([
      ["NO_LONGER_TRUE", "Launch: February → March"],
      ["EDIT", 'Edited "Launch date" → "Launch"'],
      ["ADD", 'Added "Launch date: February"'],
    ]);

    // A fact that isn't there.
    await agent.put(`/api/topic-facts/00000000-0000-4000-8000-000000000000`).send({ about: "a", statement: "b" }).expect(404);
  });

  // M42-I2
  it("undo restores a fact edited, superseded, removed as wrong or moved; a later change is undone first", async () => {
    const orion = await topic("Orion");
    const billing = await topic("Billing");
    const old = await fromEmail(orion.topicId, "Database", "PostgreSQL", "<a@client.example>");
    await db.client.topicLink.create({
      data: {
        userId,
        topicId: orion.topicId,
        messageId: "<a@client.example>",
        threadId: "<a@client.example>",
        from: "maria@client.example",
        subject: "Kickoff",
        date: new Date("2026-11-02T09:00:00Z"),
        status: "LINKED",
        via: "DIRECTION",
        evidence: "client.example",
      },
    });
    const before = await shown(orion.topicId);

    // Edited, then undone: back as it was, its source kept, not pinned.
    await agent.put(`/api/topic-facts/${old.topicFactId}`).send({ about: "Database", statement: "PostgreSQL 17" }).expect(200);
    await undoLatest(orion.topicId);
    expect(await shown(orion.topicId)).toEqual(before);
    expect((await facts(orion.topicId))[0]).toMatchObject({ source: "EMAIL", pinned: false });

    // Superseded with what is true now, then undone: the replacement gone, the old one current.
    await agent.post(`/api/topic-facts/${old.topicFactId}/no-longer-true`).send({ statement: "MySQL" }).expect(200);
    await undoLatest(orion.topicId);
    expect(await shown(orion.topicId)).toEqual(before);

    // Wrong: hidden, and what it had superseded is current again; undone: as it was.
    const newer = (await agent.post(`/api/topic-facts/${old.topicFactId}/no-longer-true`).send({ statement: "MySQL" }).expect(200))
      .body as TopicFactView;
    await agent.post(`/api/topic-facts/${newer.topicFactId}/wrong`).expect(204);
    expect(await shown(orion.topicId)).toEqual(before);
    expect(await db.client.topicFact.count({ where: { topicFactId: newer.topicFactId, status: "WRONG" } })).toBe(1);
    await agent.put(`/api/topic-facts/${newer.topicFactId}`).send({ about: "Database", statement: "x" }).expect(404);
    await undoLatest(orion.topicId);
    expect(await shown(orion.topicId)).toEqual([
      ["Database", "MySQL", "CURRENT"],
      ["Database", "PostgreSQL", "SUPERSEDED"],
    ]);
    await undoLatest(orion.topicId);
    expect(await shown(orion.topicId)).toEqual(before);

    // Moved: keeps its source, its email confirmed in Billing; undone: back, the link gone.
    const moved = (await agent.post(`/api/topic-facts/${old.topicFactId}/move`).send({ topicId: billing.topicId }).expect(200))
      .body as TopicFactView;
    expect(moved).toMatchObject({ topicId: billing.topicId, source: "EMAIL", sourceId: "<a@client.example>" });
    expect(await facts(orion.topicId)).toEqual([]);
    const links = (await agent.get(`/api/topics/${billing.topicId}/links`).expect(200)).body as TopicLinkView[];
    expect(links.map((l) => [l.subject, l.status, l.via])).toEqual([["Kickoff", "CONFIRMED", "USER"]]);
    // The move shows in both topics' history.
    expect((await changes(billing.topicId)).map((c) => c.kind)).toEqual(["MOVE"]);
    await undoLatest(billing.topicId);
    expect(await shown(orion.topicId)).toEqual(before);
    expect(await db.client.topicLink.count({ where: { topicId: billing.topicId } })).toBe(0);

    // A change a later one builds on: the later first.
    await agent.put(`/api/topic-facts/${old.topicFactId}`).send({ about: "Database", statement: "PostgreSQL 16" }).expect(200);
    await agent.put(`/api/topic-facts/${old.topicFactId}`).send({ about: "Database", statement: "PostgreSQL 17" }).expect(200);
    const [, first] = (await changes(orion.topicId)).filter((c) => !c.undone);
    await agent.post(`/api/topic-changes/${first.topicChangeId}/undo`).expect(409);
    await undoLatest(orion.topicId);
    await agent.post(`/api/topic-changes/${first.topicChangeId}/undo`).expect(204);
    await agent.post(`/api/topic-changes/${first.topicChangeId}/undo`).expect(409);
    expect(await shown(orion.topicId)).toEqual(before);
  });

  it("sources in dispute: the one the user says holds is current and pinned, the other superseded by it", async () => {
    const { topicId } = await topic("Orion");
    const adr = await fromEmail(topicId, "Database", "PostgreSQL", "<adr@client.example>");
    const ivan = await fromEmail(topicId, "database", "MySQL", "<ivan@client.example>");
    await db.client.topicFact.updateMany({ where: { topicId }, data: { status: "DISPUTED" } });
    const held = (await agent.post(`/api/topic-facts/${adr.topicFactId}/settle`).expect(200)).body as TopicFactView;
    expect(held).toMatchObject({ status: "CURRENT", pinned: true });
    const other = (await facts(topicId)).find((f) => f.topicFactId === ivan.topicFactId)!;
    expect(other).toMatchObject({ status: "SUPERSEDED", supersededById: adr.topicFactId });
    await undoLatest(topicId);
    expect((await facts(topicId)).map((f) => f.status)).toEqual(["DISPUTED", "DISPUTED"]);
  });
});

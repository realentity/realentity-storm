import { createPrismaConnection, type Prisma, type PrismaConnection } from "@realentity/storm-db";
import { type TopicBackfillView, type TopicView } from "@realentity/storm-shared";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

// M43-T5: a topic's backfill: an estimate first, started by the user, its proposals picked by the user
describe("topic backfills", () => {
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

  const proposal = (topicId: string, about: string, statement: string, date: string) => ({
    title: `Orion: ${about}: ${statement}`,
    quote: statement,
    kind: "new",
    topic: "Orion",
    topicId,
    about,
    statement,
    replaces: null,
    source: { kind: "email", messageId: `<${statement}@client.example>`, from: "maria@client.example", subject: "Plan", date },
  });

  it("one at a time; started only once estimated; only the picked proposals are kept", async () => {
    const { topicId } = (await agent.post("/api/topics").send({ name: "Orion" }).expect(201)).body as TopicView;
    expect((await agent.get(`/api/topics/${topicId}/backfill`).expect(200)).body).toEqual({});
    await agent.post(`/api/topics/${topicId}/backfill`).send({ months: 0 }).expect(400);

    const started = (await agent.post(`/api/topics/${topicId}/backfill`).send({ months: 6 }).expect(201)).body as TopicBackfillView;
    expect(started).toMatchObject({ status: "ESTIMATING", months: 6, documents: true });
    await agent.post(`/api/topics/${topicId}/backfill`).send({ months: 3 }).expect(409);
    // Not estimated yet: it can't start.
    await agent.post(`/api/topic-backfills/${started.topicBackfillId}/start`).expect(409);

    await db.client.topicBackfill.update({
      where: { topicBackfillId: started.topicBackfillId },
      data: { status: "ESTIMATED", estimateUsd: 0.12, emails: [{ messageId: "<a@x>", date: "2026-10-01" }] as Prisma.InputJsonValue },
    });
    const estimated = (await agent.get(`/api/topics/${topicId}/backfill`).expect(200)).body as TopicBackfillView;
    expect(estimated).toMatchObject({ status: "ESTIMATED", emails: 1, files: 0, estimateUsd: 0.12 });
    expect(((await agent.post(`/api/topic-backfills/${started.topicBackfillId}/start`).expect(200)).body as TopicBackfillView).status).toBe(
      "SCREENING",
    );

    // Its batches answered: two proposals wait.
    await db.client.topicBackfill.update({
      where: { topicBackfillId: started.topicBackfillId },
      data: {
        status: "REVIEW",
        proposals: [
          proposal(topicId, "Launch date", "March", "2026-10-02T09:00:00.000Z"),
          proposal(topicId, "Staging", "password: hunter2", "2026-10-03T09:00:00.000Z"),
          proposal(topicId, "Database", "PostgreSQL", "2026-10-04T09:00:00.000Z"),
        ] as Prisma.InputJsonValue,
      },
    });
    const review = (await agent.get(`/api/topics/${topicId}/backfill`).expect(200)).body as TopicBackfillView;
    expect(review.proposals.map((p) => p.title)).toEqual([
      "Orion: Launch date: March",
      "Orion: Staging: password: hunter2",
      "Orion: Database: PostgreSQL",
    ]);
    await agent
      .post(`/api/topic-backfills/${started.topicBackfillId}/apply`)
      .send({ picked: [7] })
      .expect(400);
    // The secret is never written, even picked.
    const done = (
      await agent
        .post(`/api/topic-backfills/${started.topicBackfillId}/apply`)
        .send({ picked: [0, 1] })
        .expect(200)
    ).body as TopicBackfillView;
    expect(done).toMatchObject({ status: "DONE", applied: 1 });
    expect(await db.client.topicFact.findMany({ where: { topicId }, select: { about: true, statement: true, source: true } })).toEqual([
      { about: "Launch date", statement: "March", source: "EMAIL" },
    ]);
    await agent
      .post(`/api/topic-backfills/${started.topicBackfillId}/apply`)
      .send({ picked: [2] })
      .expect(409);

    // Done: a new one can start.
    await agent.post(`/api/topics/${topicId}/backfill`).send({ months: 1, documents: false }).expect(201);
  });
});

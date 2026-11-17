import { payloadHash } from "@realentity/storm-crypto";
import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { QUEUES } from "@realentity/storm-queue";
import { type BatchDecisionView, type PipelineDetailView } from "@realentity/storm-shared";
import { defaultCatalog, type StepDefinition } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import type request from "supertest";
import { z } from "zod";
import { freeName } from "./support/names";
import { createTestApp, type TestApp } from "./support/test-app";

const TEST_STEPS: StepDefinition[] = [
  {
    type: "test.search",
    description: "returns people",
    sideEffect: false,
    saasSafe: true,
    input: z.object({ query: z.string() }),
    output: z.object({ items: z.array(z.object({ to: z.string() })) }),
  },
  {
    type: "test.send",
    description: "sends a message",
    sideEffect: true,
    saasSafe: true,
    targets: { to: "recipient" },
    input: z.object({ to: z.string(), body: z.string() }),
    output: z.object({ messageId: z.string() }),
  },
];

const SEND = `
name: Batch
steps:
  - id: search
    type: test.search
    with: { query: people }
  - id: shortlist
    type: gate.review
    with: { items: "{{search.items}}" }
  - id: reply
    type: test.send
    forEach: "{{shortlist.selected}}"
    with: { to: "{{item.to}}", body: "Hi" }
`;

const RECIPIENTS = ["ana@acme.test", "bob@acme.test", "cy@acme.test"];

// M53-T1, T4 (I1's api part): one gate step's proposals decided at once
describe("a batch of proposals", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;
  let userId: string;

  beforeAll(async () => {
    api = await createTestApp({ catalog: defaultCatalog().with(...TEST_STEPS) });
    agent = await api.signedIn();
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.$executeRaw`DELETE FROM pgboss.job`;
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  /** A run waiting at a forEach's gate: one gate step row and one proposal per item, as the worker leaves them. */
  async function waiting(): Promise<{ runId: string; ids: string[] }> {
    const pipeline = (
      await agent
        .post("/api/pipelines")
        .send({ source: await freeName(db, SEND) })
        .expect(201)
    ).body as PipelineDetailView;
    const run = await db.client.run.create({
      data: { userId, pipelineVersionId: pipeline.current!.pipelineVersionId, trigger: "manual", status: "WAITING_FOR_USER" },
    });
    const ids: string[] = [];
    for (const [index, to] of RECIPIENTS.entries()) {
      const gate = await db.client.step.create({
        data: { runId: run.runId, stepKey: "replyGate", itemIndex: index, type: "gate.act", status: "WAITING", startedAt: new Date() },
      });
      const proposal = await db.client.proposal.create({
        data: {
          userId,
          runId: run.runId,
          stepId: gate.stepId,
          stepKey: "reply",
          itemIndex: index,
          status: "PENDING_REVIEW",
          target: to,
          originalPayload: { to, body: "Hi" },
        },
      });
      ids.push(proposal.proposalId);
    }
    return { runId: run.runId, ids };
  }

  const runJobs = (runId: string) =>
    db.client.$queryRaw<unknown[]>`SELECT 1 FROM pgboss.job WHERE name LIKE ${`${QUEUES.runs}%`} AND data->>'runId' = ${runId}`;

  it("approves some and rejects the rest at once, each as proposed; the run goes on once", async () => {
    const { runId, ids } = await waiting();
    const decided = (
      await agent
        .post("/api/proposals/batch")
        .send({ approve: [ids[0], ids[1]], reject: [ids[2]], reason: "not this one" })
        .expect(200)
    ).body as BatchDecisionView;
    expect(decided).toEqual({ approved: 2, rejected: 1 });

    const rows = await db.client.proposal.findMany({ where: { runId }, include: { decision: true }, orderBy: { itemIndex: "asc" } });
    expect(rows.map((p) => [p.status, p.decision?.kind, p.decision?.reason ?? null])).toEqual([
      ["APPROVED", "APPROVED", null],
      ["APPROVED", "APPROVED", null],
      ["REJECTED", "REJECTED", "not this one"],
    ]);
    // Each executes exactly what it proposed, under its own hash.
    expect(rows[0].finalPayload).toEqual(rows[0].originalPayload);
    expect(rows[0].payloadHash).toBe(payloadHash(rows[0].originalPayload));
    expect(await runJobs(runId)).toHaveLength(1);
  });

  it("decides nothing when one was decided already, or belongs to another run", async () => {
    const first = await waiting();
    const other = await waiting();
    await agent.post(`/api/proposals/${first.ids[1]}/reject`).send({}).expect(200);
    await agent.post("/api/proposals/batch").send({ approve: first.ids }).expect(409);
    expect(await db.client.proposal.count({ where: { runId: first.runId, status: "APPROVED" } })).toBe(0);

    const mixed = await agent
      .post("/api/proposals/batch")
      .send({ approve: [first.ids[0], other.ids[0]] })
      .expect(400);
    expect((mixed.body as { message: string }).message).toBe("A batch is the proposals of one step of one run");
    await agent
      .post("/api/proposals/batch")
      .send({ approve: [first.ids[0]], reject: [first.ids[0]] })
      .expect(400);
    await agent.post("/api/proposals/batch").send({}).expect(400);
  });
});

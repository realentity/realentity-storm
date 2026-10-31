import { createPrismaConnection, type PrismaConnection } from "@ai-me/db";
import { TestEnvironment } from "@ai-me/testing";
import { NO_ATTENTION, type StepContext } from "../src/runner/step-executor";
import { DigestStep } from "../src/steps/digest-step";
import { createVersion } from "./support/test-steps";

const SIMPLE = (name: string) => `
name: ${name}
steps:
  - id: tell
    type: notify.telegram
    with: { text: hi }
`;

// M4-T7
describe("notify.digest", () => {
  let db: PrismaConnection;
  let userId: string;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  it("tells what ran, what waits for me, what failed and what the LLM cost, and sends it", async () => {
    const replies = await createVersion(db.client, userId, SIMPLE("Recruiter replies"));
    const digest = await createVersion(db.client, userId, SIMPLE("Digest"));
    const now = new Date();
    const run = (pipelineVersionId: string, status: "DONE" | "FAILED" | "WAITING_FOR_USER", hoursAgo: number, summary?: string) =>
      db.client.run.create({
        data: {
          userId,
          pipelineVersionId,
          trigger: "schedule",
          status,
          summary,
          startedAt: new Date(now.getTime() - hoursAgo * 3_600_000),
        },
      });

    const done = await run(replies, "DONE", 2);
    await db.client.step.create({
      data: {
        runId: done.runId,
        stepKey: "draft",
        type: "email.draftReply",
        status: "DONE",
        startedAt: new Date(now.getTime() - 2 * 3_600_000),
        llmUsage: { costUsd: 0.0123 },
      },
    });
    const failed = await run(replies, "FAILED", 3);
    await db.client.step.create({
      data: { runId: failed.runId, stepKey: "fetch", type: "email.fetch", status: "FAILED", error: "IMAP: connection refused" },
    });
    const waiting = await run(replies, "WAITING_FOR_USER", 1);
    const gate = await db.client.step.create({
      data: { runId: waiting.runId, stepKey: "sendGate", itemIndex: 0, type: "gate.act", status: "WAITING" },
    });
    await db.client.proposal.create({
      data: {
        userId,
        runId: waiting.runId,
        stepId: gate.stepId,
        stepKey: "send",
        itemIndex: 0,
        status: "PENDING_REVIEW",
        target: "ana@acme.test",
        originalPayload: {},
      },
    });
    await run(replies, "DONE", 30); // outside the window
    const own = await run(digest, "DONE", 0);

    const sent: string[] = [];
    const step = new DigestStep(db.client, { execute: (input) => (sent.push(input.text), Promise.resolve({ sent: true })) });
    const context: StepContext = {
      runId: own.runId,
      userId,
      pipelineId: "p",
      stepId: "s",
      stepKey: "digest",
      itemIndex: null,
      dryRun: false,
      recordUsage: () => undefined,
      attention: NO_ATTENTION,
    };
    const result = (await step.execute({ hours: 24 }, context)) as { sent: boolean; text: string };

    const lines = result.text.split("\n");
    expect(lines.slice(0, -1)).toEqual([
      "AI ME · last 24 h",
      "Runs: 3 (1 failed, 1 done, 1 waiting for me)",
      "Waiting for me: 1 (Recruiter replies: 1)",
      "Failed:",
      "• Recruiter replies: fetch: IMAP: connection refused",
    ]);
    // The month total depends on the date (2 hours ago may be last month).
    expect(lines[lines.length - 1]).toMatch(/^LLM: \$0\.0123 \(this month \$0\.0[01]\)$/);
    expect(sent).toEqual([result.text]);
  });
});

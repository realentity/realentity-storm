import { payloadHash } from "@realentity/storm-crypto";
import { createPrismaConnection, type Prisma, type PrismaConnection } from "@realentity/storm-db";
import { TestEnvironment } from "@realentity/storm-testing";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { RunControls } from "../src/runner/run-controls";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { catalog, Counting, createVersion } from "./support/test-steps";

const PIPELINE = `
name: Retry
policy: { allowedRecipients: [ana@acme.test] }
steps:
  - id: draft
    type: test.note
    with: { text: "a draft" }
  - id: send
    type: test.send
    with: { to: ana@acme.test, body: "{{draft.text}}" }
  - id: summary
    type: test.note
    with: { text: "sent {{send.messageId}}" }
  - id: tell
    type: test.note
    with: { text: "{{summary.text}}" }
`;

// M17-T1: a failed run goes on from its failed step; what ran before is kept and never repeated (M17-I1, M17-S1).
describe("M17: retrying a failed run", () => {
  let db: PrismaConnection;
  let userId: string;
  let note: Counting;
  let send: Counting;
  let runner: PipelineRunner;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(() => {
    note = new Counting("test.note", (input) => ({ text: String(input.text) }));
    send = new Counting("test.send", () => ({ messageId: "m-1" }));
    runner = new PipelineRunner(db.client, catalog, new ExecutorRegistry([note, send]), new RunControls(db.client));
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  /** What the api's retry does (RunsService.retry): the failed steps cleared, the run queued again. */
  async function retry(runId: string) {
    await db.client.step.deleteMany({ where: { runId, status: "FAILED" } });
    await db.client.run.update({ where: { runId }, data: { status: "QUEUED", finishedAt: null, summary: null } });
  }

  it("M17-I1/S1: after the send, a step fails; the retry goes on from it: the draft and the send are not repeated", async () => {
    const runId = await runner.start(await createVersion(db.client, userId, PIPELINE), { trigger: "manual" });
    expect(await runner.advance(runId)).toBe("WAITING_FOR_USER");
    const proposal = await db.client.proposal.findFirstOrThrow({ where: { runId } });
    const payload = proposal.originalPayload as Prisma.InputJsonValue;
    await db.client.proposal.update({ where: { proposalId: proposal.proposalId }, data: { status: "APPROVED", finalPayload: payload, payloadHash: payloadHash(payload) } });

    // "summary" fails once (an LLM error, say).
    const failing = new Counting("test.note", (input) => {
      if (String(input.text).startsWith("sent") && failing.calls.filter((c) => String(c.text).startsWith("sent")).length === 1) throw new Error("The LLM didn't answer");
      return { text: String(input.text) };
    });
    runner = new PipelineRunner(db.client, catalog, new ExecutorRegistry([failing, send]), new RunControls(db.client));
    expect(await runner.advance(runId)).toBe("FAILED");
    expect(send.calls).toHaveLength(1);

    await retry(runId);
    expect(await runner.advance(runId)).toBe("DONE");
    // The send ran once in all; the draft was written once, before; summary once more; tell once.
    expect(send.calls).toHaveLength(1);
    expect(failing.calls.map((c) => c.text)).toEqual(["sent m-1", "sent m-1", "sent m-1"]);
    const steps = await db.client.step.findMany({ where: { runId }, orderBy: { startedAt: "asc" } });
    expect(steps.map((s) => [s.stepKey, s.status])).toEqual([
      ["draft", "DONE"],
      ["sendGate", "DONE"],
      ["send", "DONE"],
      ["summary", "DONE"],
      ["tell", "DONE"],
    ]);
    expect(note.calls).toHaveLength(1);
  });
});

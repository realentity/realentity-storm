import { payloadHash } from "@realentity/storm-crypto";
import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { AUTO_APPROVED } from "@realentity/storm-shared";
import { TestEnvironment } from "@realentity/storm-testing";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { catalog, Counting, createVersion, JOBS } from "./support/test-steps";

jest.setTimeout(60_000);

// A recipient written in the pipeline: static, so auto-approve may act on it.
const WRITTEN = `
name: Thank Ana
steps:
  - id: reply
    type: test.send
    with: { to: ana@acme.test, body: Thanks }
`;

// Recipients from a step's output: not written in the pipeline, so a gate still asks.
const FROM_DATA = `
name: Thank recruiters
steps:
  - id: search
    type: test.search
    with: { query: dotnet }
  - id: reply
    type: test.send
    forEach: "{{search.items}}"
    with: { to: "{{item.recruiter}}", body: "Thanks for {{item.title}}" }
`;

// M54: a pipeline the user starts acts without asking, when they turned it on for this version
describe("auto-approve", () => {
  let db: PrismaConnection;
  let userId: string;
  let send: Counting;
  let runner: PipelineRunner;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(() => {
    send = new Counting("test.send", () => ({ messageId: "m-1" }));
    runner = new PipelineRunner(db.client, catalog, new ExecutorRegistry([new Counting("test.search", () => ({ items: JOBS })), send]));
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  /** Saved, with auto-approve on for its current version (what the pipeline page's switch does). */
  async function autoApproved(source: string): Promise<string> {
    const versionId = await createVersion(db.client, userId, source);
    const { pipelineId } = await db.client.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId: versionId } });
    await db.client.pipeline.update({ where: { pipelineId }, data: { autoApproveVersionId: versionId } });
    return versionId;
  }

  it("acts at once when the user starts it: the proposal approved as proposed, said as auto-approved", async () => {
    const versionId = await autoApproved(WRITTEN);
    for (const trigger of ["manual", "telegram"] as const) {
      const runId = await runner.start(versionId, { trigger });
      expect(await runner.advance(runId)).toBe("DONE");
      const [proposal] = await db.client.proposal.findMany({ where: { runId }, include: { decision: true } });
      expect(proposal).toMatchObject({ status: "DONE", decision: { kind: "APPROVED", reason: AUTO_APPROVED } });
      expect(proposal.payloadHash).toBe(payloadHash(proposal.originalPayload));
    }
    expect(send.calls).toEqual([
      { to: "ana@acme.test", body: "Thanks" },
      { to: "ana@acme.test", body: "Thanks" },
    ]);
  });

  it("still asks on a schedule, for another version, or for a target not written in the pipeline", async () => {
    const versionId = await autoApproved(WRITTEN);
    expect(await runner.advance(await runner.start(versionId, { trigger: "schedule" }))).toBe("WAITING_FOR_USER");

    const { pipelineId } = await db.client.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId: versionId } });
    await db.client.pipeline.update({ where: { pipelineId }, data: { autoApproveVersionId: null } });
    expect(await runner.advance(await runner.start(versionId, { trigger: "manual" }))).toBe("WAITING_FOR_USER");

    const fromData = await autoApproved(FROM_DATA);
    const runId = await runner.start(fromData, { trigger: "manual" });
    expect(await runner.advance(runId)).toBe("WAITING_FOR_USER");
    expect(await db.client.proposal.count({ where: { runId, status: "PENDING_REVIEW" } })).toBe(2);
    expect(send.calls).toEqual([]);
  });

  it("never in a dry run: its proposals stay previews", async () => {
    const versionId = await autoApproved(WRITTEN);
    const runId = await runner.start(versionId, { trigger: "dry-run", dryRun: true });
    expect(await runner.advance(runId)).toBe("DONE");
    expect(await db.client.proposal.findMany({ where: { runId } })).toEqual([expect.objectContaining({ status: "PREVIEW" })]);
    expect(send.calls).toEqual([]);
  });
});

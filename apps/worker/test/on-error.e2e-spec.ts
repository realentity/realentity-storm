import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { PipelineDefinitionSchema } from "@realentity/storm-shared";
import { TestEnvironment } from "@realentity/storm-testing";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { catalog, Counting, createVersion, JOBS } from "./support/test-steps";

jest.setTimeout(60_000);

const source = (onError: string) => `
name: Notes ${onError}
steps:
  - id: search
    type: test.search
    with: { query: dotnet }
  - id: note
    type: test.note
    forEach: "{{search.items}}"
    ${onError === "none" ? "" : `onError: ${onError}`}
    with: { text: "{{item.title}}" }
  - id: again
    type: test.note
    forEach: "{{search.items}}"
    with: { text: "again {{item.title}}" }
`;

// M54-T5: onError: continue: a failed item is recorded, the others go on, the run ends done saying what failed
describe("onError", () => {
  let db: PrismaConnection;
  let userId: string;
  let note: Counting;
  let runner: PipelineRunner;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(() => {
    // The first item's note fails (no retries); every other call works.
    note = new Counting("test.note", (input) => ({ text: input.text }));
    note.failuresLeft = 1;
    runner = new PipelineRunner(db.client, catalog, new ExecutorRegistry([new Counting("test.search", () => ({ items: JOBS })), note]));
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  it("continue: the other items go on, the failed one's later steps are skipped, the run is done saying so", async () => {
    const runId = await runner.start(await createVersion(db.client, userId, source("continue")), { trigger: "manual" });
    expect(await runner.advance(runId)).toBe("DONE");
    expect(await db.client.run.findUniqueOrThrow({ where: { runId } })).toMatchObject({
      status: "DONE",
      summary: "1 item failed: note #1",
    });
    const steps = await db.client.step.findMany({
      where: { runId, stepKey: { in: ["note", "again"] } },
      orderBy: [{ stepKey: "asc" }, { itemIndex: "asc" }],
    });
    expect(steps.map((s) => [s.stepKey, s.itemIndex, s.status, s.status === "SKIPPED" ? s.error : null])).toEqual([
      ["again", 0, "SKIPPED", "Its item failed at an earlier step"],
      ["again", 1, "DONE", null],
      ["note", 0, "FAILED", null],
      ["note", 1, "DONE", null],
    ]);
  });

  it("stop (the default): the first failure fails the run", async () => {
    const runId = await runner.start(await createVersion(db.client, userId, source("none")), { trigger: "manual" });
    expect(await runner.advance(runId)).toBe("FAILED");
    expect(note.calls).toHaveLength(1);
  });

  it("only with forEach", () => {
    const result = PipelineDefinitionSchema.safeParse({
      name: "X",
      steps: [{ id: "a", type: "test.note", onError: "continue", with: { text: "hi" } }],
    });
    expect(result.error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`)).toEqual([
      "steps.0.onError: onError: continue is for a step with forEach: the other items go on",
    ]);
  });
});

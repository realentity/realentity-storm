import { createPrismaConnection, type PrismaConnection } from "@ai-me/db";
import { AppDefinitionSchema } from "@ai-me/shared";
import { TestEnvironment } from "@ai-me/testing";
import { NO_ATTENTION, type StepContext } from "../src/runner/step-executor";
import { SaveStep } from "../src/steps/data-steps";
import { ReadStep } from "../src/steps/entity-steps";
import { catalog } from "./support/test-steps";

const APPLICATIONS = AppDefinitionSchema.parse({
  name: "Applications",
  types: {
    Job: {
      key: "url",
      stages: {
        field: "status",
        initial: "new",
        states: ["new", "applied", "interview", "rejected"],
        moves: [
          { from: "new", to: ["applied"] },
          { from: ["new", "applied"], to: ["interview", "rejected"], by: ["me", "pipeline"] },
          { from: "interview", to: ["rejected"], by: ["me", "pipeline"] },
        ],
      },
      fields: { url: { type: "url", required: true }, title: { type: "text" } },
    },
    Company: { mine: true, key: "name", fields: { name: { type: "text", required: true } } },
  },
});

type Saved = {
  added: Record<string, unknown>[];
  changed: { key: string; before: Record<string, unknown>; after: Record<string, unknown> }[];
  invalid: { key: string | null; problems: string[] }[];
};

// M32-I1 (the pipeline's half): stages moved by data.save, forward only, as the moves allow
describe("M32: stages", () => {
  let db: PrismaConnection;
  let userId: string;
  let emitted: Record<string, unknown>[];

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(async () => {
    emitted = [];
    const app = await db.client.app.create({ data: { userId, name: APPLICATIONS.name } });
    const version = await db.client.appVersion.create({
      data: { appId: app.appId, version: 1, definition: APPLICATIONS as never, source: JSON.stringify(APPLICATIONS) },
    });
    await db.client.app.update({ where: { appId: app.appId }, data: { currentVersionId: version.appVersionId } });
  });

  afterEach(async () => {
    await db.client.app.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  const context: StepContext = {
    runId: "00000000-0000-4000-8000-000000000001",
    userId: "",
    pipelineId: "00000000-0000-4000-8000-000000000002",
    stepId: "s",
    stepKey: "k",
    itemIndex: null,
    dryRun: false,
    app: "Applications",
    recordUsage: () => undefined,
    attention: NO_ATTENTION,
    emit: (_event, data) => {
      emitted.push(data);
      return Promise.resolve();
    },
  };
  const save = (items: Record<string, unknown>[], type = "Job") =>
    new SaveStep(db.client).execute(catalog.get("data.save")!.input.parse({ items, type }), { ...context, userId }) as Promise<Saved>;
  const job = (status?: string) => ({ url: "https://jobs.test/1", title: "Dev", ...(status ? { status } : {}) });
  const entity = () => db.client.dataEntity.findFirstOrThrow({ where: { key: "https://jobs.test/1" } });

  it("starts at the initial stage, moves forward as a pipeline may, and never back", async () => {
    const first = await save([job()]);
    expect(first.added).toEqual([{ ...job(), status: "new" }]);
    expect(emitted[0]).toMatchObject({ stage: { from: null, to: "new" } });
    expect((await entity()).stageDates).toEqual({ new: expect.any(String) as unknown });

    // new → applied is mine to make, not a pipeline's: said, and the rest saved.
    const applied = await save([{ ...job("applied"), title: "Developer" }]);
    expect(applied.invalid).toEqual([{ key: "https://jobs.test/1", saved: true, problems: ["status can't move from new to applied"] }]);
    expect(applied.changed).toEqual([expect.objectContaining({ before: { title: "Dev" }, after: { title: "Developer" } })]);
    expect((await entity()).stage).toBe("new");

    emitted = [];
    const interview = await save([{ ...job("interview"), title: "Developer" }]);
    expect(interview.changed).toEqual([expect.objectContaining({ before: { status: "new" }, after: { status: "interview" } })]);
    expect(emitted).toEqual([expect.objectContaining({ changed: ["status"], stage: { from: "new", to: "interview" } })]);

    // An email re-read: back to applied isn't a move a pipeline may make.
    expect((await save([{ ...job("applied"), title: "Developer" }])).invalid[0]?.problems).toEqual([
      "status can't move from interview to applied",
    ]);
    const saved = await entity();
    expect([saved.stage, Object.keys(saved.stageDates as object).sort()]).toEqual(["interview", ["interview", "new"]]);
    expect(saved.value).toEqual({ url: "https://jobs.test/1", title: "Developer" });

    const read = (await new ReadStep(db.client).execute(
      catalog.get("data.read")!.input.parse({ type: "Job", where: [{ field: "status", op: "eq", value: "interview" }] }),
      {
        ...context,
        userId,
      },
    )) as { items: Record<string, unknown>[] };
    expect(read.items).toEqual([{ ...job("interview"), title: "Developer" }]);
  });

  it("refuses to write a type of mine", async () => {
    await expect(save([{ name: "Acme" }], "Company")).rejects.toThrow("Company is a type of mine: pipelines read it, only I write it");
  });
});

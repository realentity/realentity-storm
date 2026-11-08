import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { JobQueue, QUEUES, type EventJob } from "@realentity/storm-queue";
import { AppDefinitionSchema, type AppDefinition } from "@realentity/storm-shared";
import { TestEnvironment } from "@realentity/storm-testing";
import { KeyRing } from "@realentity/storm-crypto";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry, NO_ATTENTION, type StepContext } from "../src/runner/step-executor";
import { Triggers } from "../src/runner/triggers";
import { SaveStep } from "../src/steps/data-steps";
import { ReadStep } from "../src/steps/entity-steps";
import { catalog, Counting, createVersion } from "./support/test-steps";

const JOB_SEARCH: AppDefinition = AppDefinitionSchema.parse({
  name: "Job Search",
  types: {
    Job: {
      key: "url",
      title: "position",
      fields: {
        url: { type: "url", required: true },
        position: { type: "text", required: true },
        salary: { type: "money" },
        posted: { type: "date" },
        favorite: { type: "yesno", mine: true },
      },
    },
  },
});

const job = (n: number, extra: Record<string, unknown> = {}) => ({
  url: `https://jobs.test/${n}`,
  position: `Developer ${n}`,
  salary: 4000 + n,
  ...extra,
});

type Saved = {
  saved: number;
  created: number;
  skipped: number;
  added: Record<string, unknown>[];
  changed: { key: string; before: Record<string, unknown>; after: Record<string, unknown> }[];
  removed: Record<string, unknown>[];
  invalid: { key: string | null; saved: boolean; problems: string[] }[];
};

// M30-I1: entities of an App's type
describe("M30: entities", () => {
  let db: PrismaConnection;
  let userId: string;
  let appId: string;
  let emitted: { event: string; data: Record<string, unknown> }[];

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(async () => {
    emitted = [];
    const app = await db.client.app.create({ data: { userId, name: JOB_SEARCH.name } });
    const version = await db.client.appVersion.create({
      data: { appId: app.appId, version: 1, definition: JOB_SEARCH as never, source: JSON.stringify(JOB_SEARCH) },
    });
    await db.client.app.update({ where: { appId: app.appId }, data: { currentVersionId: version.appVersionId } });
    appId = app.appId;
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.app.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  const context = (dryRun = false): StepContext => ({
    runId: "00000000-0000-4000-8000-000000000001",
    userId,
    pipelineId: "00000000-0000-4000-8000-000000000002",
    stepId: "s",
    stepKey: "k",
    itemIndex: null,
    dryRun,
    app: "Job Search",
    recordUsage: () => undefined,
    attention: NO_ATTENTION,
    emit: (event, data) => {
      if (!dryRun) emitted.push({ event, data });
      return Promise.resolve();
    },
  });

  const save = (items: Record<string, unknown>[], extra: Record<string, unknown> = {}, dryRun = false) =>
    new SaveStep(db.client).execute(
      catalog.get("data.save")!.input.parse({ items, type: "Job", ...extra }),
      context(dryRun),
    ) as Promise<Saved>;
  const read = (input: Record<string, unknown>) =>
    new ReadStep(db.client).execute(catalog.get("data.read")!.input.parse({ type: "Job", ...input }), context()) as Promise<{
      items: Record<string, unknown>[];
      count: number;
    }>;

  it("writes, changes, removes and brings back entities, telling once per change", async () => {
    const first = await save([job(1), job(2, { salary: "4 500", posted: "2026-11-01T08:00:00Z" })]);
    expect(first).toMatchObject({ saved: 2, created: 2, changed: [], removed: [], invalid: [] });
    expect(first.added[1]).toEqual({ url: "https://jobs.test/2", position: "Developer 2", salary: 4500, posted: "2026-11-01" });
    expect(emitted.map((e) => [e.data.key, e.data.before, e.data.changed, e.data.by])).toEqual([
      ["https://jobs.test/1", null, ["url", "position", "salary"], "pipeline"],
      ["https://jobs.test/2", null, ["url", "position", "salary", "posted"], "pipeline"],
    ]);

    emitted = [];
    expect(await save([job(1), job(2, { salary: 4500, posted: "2026-11-01" })])).toMatchObject({ created: 0, changed: [] });
    expect(emitted).toEqual([]);

    const raised = await save([job(1, { salary: 5000 })]);
    expect(raised.changed).toEqual([
      expect.objectContaining({ key: "https://jobs.test/1", before: { salary: 4001 }, after: { salary: 5000 } }),
    ]);
    expect(emitted).toEqual([
      {
        event: "entity.changed",
        data: {
          app: "Job Search",
          appId: expect.any(String) as unknown,
          type: "Job",
          key: "https://jobs.test/1",
          item: job(1, { salary: 5000 }),
          before: job(1),
          changed: ["salary"],
          by: "pipeline",
          stage: null,
        },
      },
    ]);

    const removed = await save([job(1, { salary: 5000 })], { complete: true });
    expect(removed.removed).toEqual([expect.objectContaining({ url: "https://jobs.test/2" })]);
    expect(await db.client.dataEntity.count({ where: { appId, removedAt: { not: null } } })).toBe(1);
    expect((await save([job(2, { salary: 4500, posted: "2026-11-01" })])).created).toBe(1);
    expect(await db.client.dataEntity.count({ where: { appId, removedAt: null } })).toBe(2);
  });

  it("keeps my fields through every write, and never takes one from a pipeline", async () => {
    await save([job(1)]);
    await db.client.dataEntity.updateMany({ data: { mine: { favorite: true } } });
    const result = await save([job(1, { salary: 6000, favorite: false })]);
    expect(result.invalid).toEqual([{ key: "https://jobs.test/1", saved: true, problems: ["favorite is mine: a pipeline can't set it"] }]);
    await save([job(3)], { complete: true });
    await save([job(1, { salary: 6000 })]);
    const saved = await db.client.dataEntity.findFirstOrThrow({ where: { key: "https://jobs.test/1" } });
    expect([saved.value, saved.mine, saved.removedAt]).toEqual([job(1, { salary: 6000 }), { favorite: true }, null]);
    expect((await read({ where: [{ field: "favorite", op: "eq", value: true }] })).items).toEqual([
      { ...job(1, { salary: 6000 }), favorite: true },
    ]);
  });

  it("leaves out a wrong field, saves nothing without a required one, and nothing in a dry run", async () => {
    const result = await save([job(1, { salary: "a lot" }), { url: "https://jobs.test/2" }, { position: "No url" }]);
    expect(result).toMatchObject({ saved: 1, skipped: 2 });
    expect(result.invalid).toEqual([
      { key: "https://jobs.test/1", saved: true, problems: ["salary isn't a number"] },
      { key: null, saved: false, problems: ["position is missing"] },
      { key: null, saved: false, problems: ["url is missing"] },
    ]);
    expect(await db.client.dataEntity.count()).toBe(1);

    const dry = await save([job(5)], {}, true);
    expect(dry.created).toBe(1);
    expect(await db.client.dataEntity.count()).toBe(1);
  });

  it("data.read: where, sort, limit, and the removed ones apart", async () => {
    await save([job(1), job(2), job(3, { salary: undefined })]);
    expect((await read({ sort: "-salary" })).items.map((i) => i.url)).toEqual([
      "https://jobs.test/2",
      "https://jobs.test/1",
      "https://jobs.test/3",
    ]);
    expect(await read({ where: [{ field: "salary", op: "gt", value: 4001 }] })).toEqual({ items: [job(2)], count: 1 });
    expect((await read({ sort: "position", limit: 1 })).items).toEqual([job(1)]);
    await save([job(1)], { complete: true });
    expect((await read({ removed: true })).items.map((i) => i.url).sort()).toEqual(["https://jobs.test/2", "https://jobs.test/3"]);
  });

  describe("entity.changed", () => {
    let queue: JobQueue;
    let triggers: Triggers;

    beforeAll(async () => {
      queue = await JobQueue.start({ connectionString: process.env.DATABASE_URL!, role: "worker" });
    });

    beforeEach(async () => {
      const note = new Counting("test.note", (input) => ({ text: input.text }));
      const runner = new PipelineRunner(db.client, catalog, new ExecutorRegistry([note]));
      triggers = new Triggers(db.client, runner, queue, KeyRing.fromEnv(process.env));
      for (const name of Object.values(QUEUES)) await queue.boss.deleteAllJobs(name);
    });

    afterAll(async () => {
      await queue.stop();
    });

    const watcher = (name: string, app: string, field?: string) => `
name: ${name}
app: ${app}
trigger: { on: entity.changed, type: Job${field ? `, field: ${field}` : ""} }
steps:
  - id: note
    type: test.note
    with: { text: "{{trigger.item.position}}: {{trigger.before.salary}} → {{trigger.item.salary}}" }
`;

    async function enabled(source: string, app: AppDefinition): Promise<string> {
      const versionId = await createVersion(db.client, userId, source, undefined, { app });
      const { pipelineId } = await db.client.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId: versionId } });
      await db.client.pipeline.update({ where: { pipelineId }, data: { enabled: true } });
      return pipelineId;
    }

    it("starts the App's pipelines watching the type (and the field), never the writer itself or another App's", async () => {
      const salary = await enabled(watcher("Salary watch", "Job Search", "salary"), JOB_SEARCH);
      await enabled(watcher("Any change", "Job Search"), JOB_SEARCH);
      const other = AppDefinitionSchema.parse({ ...JOB_SEARCH, name: "Other" });
      await enabled(watcher("Other app", "Other"), other);

      const event = (changed: string[], pipelineId = "00000000-0000-4000-8000-000000000002"): EventJob => ({
        userId,
        event: "entity.changed",
        data: { app: "Job Search", type: "Job", key: "https://jobs.test/1", item: job(1), before: job(1), changed, by: "pipeline" },
        source: { runId: "00000000-0000-4000-8000-000000000001", pipelineId, depth: 0 },
      });
      const started = async (e: EventJob) => {
        const runIds = await triggers.fire(e);
        const runs = await db.client.run.findMany({
          where: { runId: { in: runIds } },
          include: { pipelineVersion: { include: { pipeline: true } } },
        });
        return runs.map((r) => r.pipelineVersion.pipeline.name).sort();
      };

      expect(await started(event(["salary"]))).toEqual(["Any change", "Salary watch"]);
      expect(await started(event(["position"]))).toEqual(["Any change"]);
      expect(await started(event(["salary"], salary))).toEqual(["Any change"]);
    });
  });
});

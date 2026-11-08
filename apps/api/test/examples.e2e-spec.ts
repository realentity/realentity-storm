import { createPrismaConnection, type PrismaConnection } from "@ai-me/db";
import {
  definitionToSource,
  freeNames,
  joinBundle,
  readExamples,
  splitBundle,
  type BundleCheckView,
  type ChecklistView,
  type CompiledDefinition,
  type SetupView,
} from "@ai-me/shared";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

const PIPELINES = join(__dirname, "../../../pipelines");
const EXAMPLES = readExamples(readFileSync(join(PIPELINES, "examples.yaml"), "utf8"));
const bundleOf = (files: string[]) => joinBundle(files.map((f) => readFileSync(join(PIPELINES, f), "utf8")));

// M40-I1: every example installs into an empty account and compiles; installed twice, there are two
describe("examples", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;

  beforeAll(async () => {
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.app.deleteMany();
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  for (const example of EXAMPLES) {
    it(`${example.id}: installs into an empty account, its pipelines compiling against its App`, async () => {
      const check = (
        await agent
          .post("/api/bundles/check")
          .send({ text: bundleOf(example.files) })
          .expect(201)
      ).body as BundleCheckView;
      expect({ ok: check.ok, errors: check.errors, items: check.items.flatMap((i) => i.errors) }).toEqual({
        ok: true,
        errors: [],
        items: [],
      });
      expect(check.items.map((i) => i.action)).toEqual(example.files.map(() => "create"));
    });
  }

  // M40-T2, T3: what is set up; an installed example's checklist, ticked as it is done
  it("an installed example's checklist: its needs, then its pipelines tried and switched on", async () => {
    const setup = (await agent.get("/api/examples/setup").expect(200)).body as SetupView;
    expect(setup).toMatchObject({ googleCalendar: false, credentials: [], recipes: [] });

    const prices = EXAMPLES.find((e) => e.id === "prices")!;
    await agent
      .post("/api/bundles")
      .send({ text: bundleOf(prices.files), example: { id: prices.id, needs: prices.needs } })
      .expect(201);
    const app = await db.client.app.findFirstOrThrow({ where: { name: "Prices" } });
    const pipeline = await db.client.pipeline.findFirstOrThrow({ where: { name: "Prices" } });
    const checklist = async () => (await agent.get(`/api/examples/apps/${app.appId}/checklist`).expect(200)).body as ChecklistView;

    const first = await checklist();
    expect(first.example).toBe("prices");
    expect(first.items.map((i) => [i.label, i.done])).toEqual([
      ["The products to watch, added on its page", false],
      ["Telegram, to tell you about drops", setup.telegram],
      ['Try "Prices": a dry run, which sends and saves nothing', false],
      ['Switch "Prices" on', false],
    ]);
    expect(first.items[0].link).toBe(`/a/${app.appId}/Product`);
    expect(first.done).toBe(false);

    const saved = (await agent.get(`/api/pipelines/${pipeline.pipelineId}`).expect(200)).body as {
      current: { definition: CompiledDefinition };
    };
    const source = definitionToSource(saved.current.definition);
    await agent.post("/api/pipelines/dry-run").send({ source, pipelineId: pipeline.pipelineId }).expect(202);
    await agent.patch(`/api/pipelines/${pipeline.pipelineId}`).send({ enabled: true }).expect(200);
    const after = await checklist();
    expect(after.items.slice(2).map((i) => i.done)).toEqual([true, true]);

    // An App not installed from an example has none.
    const other = (
      await agent
        .post("/api/apps")
        .send({ source: "name: Plain\ntypes:\n  Item:\n    key: name\n    fields:\n      name: { type: text, required: true }\n" })
        .expect(201)
    ).body as { appId: string };
    expect((await agent.get(`/api/examples/apps/${other.appId}/checklist`).expect(200)).body).toEqual({});
  });

  it("installed twice: a second App and pipelines, under free names", async () => {
    const [starter] = EXAMPLES;
    await agent
      .post("/api/bundles")
      .send({ text: bundleOf(starter.files) })
      .expect(201);
    const taken = {
      apps: (await db.client.app.findMany()).map((a) => a.name),
      pipelines: (await db.client.pipeline.findMany()).map((p) => p.name),
    };
    const again = joinBundle(freeNames(splitBundle(bundleOf(starter.files)), taken));
    const check = (await agent.post("/api/bundles/check").send({ text: again }).expect(201)).body as BundleCheckView;
    expect(check.ok).toBe(true);
    expect(check.items.map((i) => [i.name, i.action])).toEqual([
      ["Releases to read 2", "create"],
      ["Read release feeds (2)", "create"],
    ]);
    await agent.post("/api/bundles").send({ text: again }).expect(201);
    expect(await db.client.app.count()).toBe(2);
    expect(await db.client.pipeline.count()).toBe(2);
  });
});

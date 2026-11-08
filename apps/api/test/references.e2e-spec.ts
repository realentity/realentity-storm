import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { definitionToSource, type PipelineDetailView } from "@realentity/storm-shared";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

const APP = (name = "Shelf") => `name: ${name}
types:
  Book:
    key: isbn
    fields:
      isbn: { type: text, required: true }
      title: { type: text }
`;

const SAVER = (name = "Books in", app = "Shelf") => `name: ${name}
app: ${app}
steps:
  - id: save
    type: data.save
    with:
      type: Book
      items:
        - { isbn: "978-0", title: Dune }
`;

const PLAIN = (name: string) => `name: ${name}
steps:
  - id: note
    type: llm.generate
    with: { instruction: "Say hi" }
`;

const BACKFILL = join(__dirname, "../../../packages/db/prisma/migrations/20270508000000_refs_backfill/migration.sql");
const MIGRATION = join(__dirname, "../../../packages/db/prisma/migrations/20270506000000_pipeline_names_unique/migration.sql");

// M39: references that survive a rename
describe("references", () => {
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

  const create = async (source: string) => (await agent.post("/api/pipelines").send({ source }).expect(201)).body as PipelineDetailView;

  // M39-I3
  it("a saved pipeline's name is its own: taken on create or rename is refused, a dry run of a new one is not", async () => {
    const first = await create(PLAIN("Morning"));
    const refused = await agent
      .post("/api/pipelines")
      .send({ source: PLAIN("Morning") })
      .expect(409);
    expect((refused.body as { message: string }).message).toBe('There is already a pipeline named "Morning": give this one another name');

    const other = await create(PLAIN("Evening"));
    await agent
      .post(`/api/pipelines/${other.pipelineId}/versions`)
      .send({ source: PLAIN("Morning") })
      .expect(409);
    // Its own name, unchanged, is no conflict.
    await agent
      .post(`/api/pipelines/${first.pipelineId}/versions`)
      .send({ source: PLAIN("Morning").replace("Say hi", "Say hello") })
      .expect(201);

    // A draft of a new one may share it until it is saved.
    const draft = (
      await agent
        .post("/api/pipelines/dry-run")
        .send({ source: PLAIN("Morning") })
        .expect(202)
    ).body as { pipeline: PipelineDetailView };
    await agent
      .post(`/api/pipelines/${draft.pipeline.pipelineId}/versions`)
      .send({ source: PLAIN("Morning") })
      .expect(409);
    await agent
      .post(`/api/pipelines/${draft.pipeline.pipelineId}/versions`)
      .send({ source: PLAIN("Morning 2") })
      .expect(201);
  });

  // M39-U1
  it("the migration: the duplicates there are get (2), (3), the oldest keeping the name, a name not taken", async () => {
    const pipelines = [];
    for (const name of ["Dup", "Dup b", "Dup c", "Dup (2)"]) pipelines.push(await create(PLAIN(name)));
    const [oldest, second, third, taken] = pipelines;
    await db.client.$executeRawUnsafe(`DROP INDEX "Pipelines_userId_name_saved_key"`);
    const day = (n: number) => new Date(Date.UTC(2026, 0, n));
    await db.client.pipeline.update({ where: { pipelineId: oldest.pipelineId }, data: { dateCreated: day(1) } });
    await db.client.pipeline.update({ where: { pipelineId: second.pipelineId }, data: { name: "Dup", dateCreated: day(2) } });
    await db.client.pipeline.update({ where: { pipelineId: third.pipelineId }, data: { name: "Dup", dateCreated: day(3) } });

    // The migration as it is written: its block, then its index.
    const sql = readFileSync(MIGRATION, "utf8");
    const block = sql.slice(sql.indexOf("DO $$"), sql.indexOf("END $$;") + "END $$;".length);
    const index = sql.slice(sql.indexOf("CREATE UNIQUE INDEX"));
    await db.client.$executeRawUnsafe(block);
    await db.client.$executeRawUnsafe(index);

    const name = async (p: PipelineDetailView) =>
      (await db.client.pipeline.findUniqueOrThrow({ where: { pipelineId: p.pipelineId } })).name;
    expect(await name(oldest)).toBe("Dup");
    expect(await name(taken)).toBe("Dup (2)");
    expect(await name(second)).toBe("Dup (3)");
    expect(await name(third)).toBe("Dup (4)");
    // The index holds from now on.
    await expect(db.client.pipeline.update({ where: { pipelineId: third.pipelineId }, data: { name: "Dup" } })).rejects.toThrow();
  });

  // M39-T2
  it("what a definition names is kept by id when it is saved; a name with nothing behind it yet is a warning", async () => {
    const app = (await agent.post("/api/apps").send({ source: APP() }).expect(201)).body as { appId: string };
    const saver = await create(SAVER());
    const later = await create(
      `name: Later\ntrigger: { on: flow.later }\nsteps:\n  - id: note\n    type: llm.generate\n    with: { instruction: "Say hi" }\n`,
    );
    const after = await create(`name: After
app: Shelf
trigger: { on: run.finished, pipeline: Books in }
steps:
  - id: soon
    type: flow.later
    with: { pipeline: Later, after: 1d }
`);
    const version = await db.client.pipelineVersion.findUniqueOrThrow({
      where: {
        pipelineVersionId: (await db.client.pipeline.findUniqueOrThrow({ where: { pipelineId: after.pipelineId } })).currentVersionId!,
      },
    });
    expect((version.definition as { refs: unknown }).refs).toEqual({
      appId: app.appId,
      pipelines: { "Books in": saver.pipelineId, Later: later.pipelineId },
    });

    // A pipeline it names that isn't saved yet: a warning, not a refusal.
    const compiled = (
      await agent
        .post("/api/pipelines/compile")
        .send({
          source: `name: Waits\ntrigger: { on: run.finished, pipeline: Not yet }\nsteps:\n  - id: note\n    type: llm.generate\n    with: { instruction: "Say hi" }\n`,
        })
        .expect(200)
    ).body as { result: { ok: boolean; warnings: { message: string }[] } };
    expect(compiled.result.ok).toBe(true);
    expect(compiled.result.warnings.map((w) => w.message)).toContain(
      'There is no pipeline named "Not yet" yet: it is looked up by name when this runs',
    );

    // An App's buttons: the pipelines they run, by id, with its version.
    const withButton = APP().replace(
      "      title: { type: text }\n",
      "      title: { type: text }\npages:\n  - list: Book\n    actions:\n      - { label: Fetch now, run: Books in }\n",
    );
    await agent.put(`/api/apps/${app.appId}`).send({ source: withButton }).expect(200);
    const appVersion = await db.client.appVersion.findFirstOrThrow({ where: { appId: app.appId }, orderBy: { version: "desc" } });
    expect(appVersion.refs).toEqual({ pipelines: { "Books in": saver.pipelineId } });
  });

  // M39-T3 (M39-I1's api part): an App renamed under its pipelines: allowed, they stay its own
  it("an App with pipelines can be renamed; they stay its own, listed under its new name", async () => {
    const app = (await agent.post("/api/apps").send({ source: APP() }).expect(201)).body as { appId: string };
    const saver = await create(SAVER());
    await agent
      .put(`/api/apps/${app.appId}`)
      .send({ source: APP("Library") })
      .expect(200);
    const detail = (await agent.get(`/api/apps/${app.appId}`).expect(200)).body as { name: string; pipelines: { pipelineId: string }[] };
    expect(detail.name).toBe("Library");
    expect(detail.pipelines.map((p) => p.pipelineId)).toEqual([saver.pipelineId]);
    // A change that breaks it is still refused, under the new name.
    const broken = await agent
      .put(`/api/apps/${app.appId}`)
      .send({ source: APP("Library").replace("Book:", "Volume:") })
      .expect(409);
    expect(JSON.stringify(broken.body)).toContain('\\"Library\\" has no type \\"Book\\"');
  });

  // M39-T3 (M39-I2's api part): a button runs the pipeline its App's version was saved with, renamed since or not
  it("an App's button still starts its pipeline after the pipeline is renamed", async () => {
    const app = (await agent.post("/api/apps").send({ source: APP() }).expect(201)).body as { appId: string };
    const saver = await create(SAVER());
    const withButton = APP().replace(
      "      title: { type: text }\n",
      "      title: { type: text }\npages:\n  - list: Book\n    actions:\n      - { label: Fetch now, run: Books in }\n",
    );
    await agent.put(`/api/apps/${app.appId}`).send({ source: withButton }).expect(200);
    await agent
      .post(`/api/pipelines/${saver.pipelineId}/versions`)
      .send({ source: SAVER("Books fetched") })
      .expect(201);
    const run = (await agent.post(`/api/apps/${app.appId}/actions/Book/0`).send({}).expect(202)).body as { pipelineId: string };
    expect(run.pipelineId).toBe(saver.pipelineId);
  });

  // M39-T4: what is shown (the editor, the export, the App's YAML) is the names things have now
  it("shows the names things have now: a renamed App and pipeline in what refers to them, and saves them so", async () => {
    const app = (await agent.post("/api/apps").send({ source: APP() }).expect(201)).body as { appId: string };
    const saver = await create(SAVER());
    const after = await create(
      `name: After\napp: Shelf\ntrigger: { on: run.finished, pipeline: Books in }\nsteps:\n  - id: note\n    type: llm.generate\n    with: { instruction: "Say hi" }\n`,
    );
    const withButton = APP().replace(
      "      title: { type: text }\n",
      "      title: { type: text }\npages:\n  - list: Book\n    actions:\n      - { label: Fetch now, run: Books in }\n",
    );
    await agent.put(`/api/apps/${app.appId}`).send({ source: withButton }).expect(200);
    await agent
      .put(`/api/apps/${app.appId}`)
      .send({ source: withButton.replace("name: Shelf", "name: Library") })
      .expect(200);
    await agent
      .post(`/api/pipelines/${saver.pipelineId}/versions`)
      .send({ source: SAVER("Books fetched", "Library") })
      .expect(201);

    const shown = (await agent.get(`/api/pipelines/${after.pipelineId}`).expect(200)).body as PipelineDetailView;
    expect(shown.current!.definition).toMatchObject({ app: "Library", trigger: { on: "run.finished", pipeline: "Books fetched" } });
    const exported = (await agent.get(`/api/bundles/pipelines/${after.pipelineId}`).expect(200)).body as { text: string };
    expect(exported.text).toContain("app: Library\n");
    expect(exported.text).toContain("pipeline: Books fetched");
    const appShown = (await agent.get(`/api/apps/${app.appId}`).expect(200)).body as { source: string };
    expect(appShown.source).toContain("run: Books fetched");

    // What the editor shows saves as it is: the names now are what the next version is saved with.
    const source = definitionToSource(shown.current!.definition).replace("Say hi", "Say hello");
    await agent.post(`/api/pipelines/${after.pipelineId}/versions`).send({ source }).expect(201);
  });

  // M39-T5: a rename says what follows it, before Save
  it("a rename in the editors says what refers to what is renamed", async () => {
    const app = (await agent.post("/api/apps").send({ source: APP() }).expect(201)).body as { appId: string };
    const saver = await create(SAVER());
    await create(
      `name: After\napp: Shelf\ntrigger: { on: run.finished, pipeline: Books in }\nsteps:\n  - id: note\n    type: llm.generate\n    with: { instruction: "Say hi" }\n`,
    );
    const withButton = APP().replace(
      "      title: { type: text }\n",
      "      title: { type: text }\npages:\n  - list: Book\n    actions:\n      - { label: Fetch now, run: Books in }\n",
    );
    await agent.put(`/api/apps/${app.appId}`).send({ source: withButton }).expect(200);

    const compiled = (
      await agent
        .post("/api/pipelines/compile")
        .send({ source: SAVER("Books fetched"), pipelineId: saver.pipelineId })
        .expect(200)
    ).body as { renamed?: unknown };
    expect(compiled.renamed).toEqual({
      from: "Books in",
      to: "Books fetched",
      followers: ['"After" (its trigger)', 'a button of "Shelf"'],
    });
    const same = (await agent.post("/api/pipelines/compile").send({ source: SAVER(), pipelineId: saver.pipelineId }).expect(200)).body as {
      renamed?: unknown;
    };
    expect(same.renamed).toBeUndefined();

    const checked = (
      await agent
        .post("/api/apps/check")
        .send({ source: withButton.replace("name: Shelf", "name: Library"), appId: app.appId })
        .expect(201)
    ).body as { renamed?: unknown };
    expect(checked.renamed).toEqual({ from: "Shelf", to: "Library", followers: ["After", "Books in"] });
  });

  // M39-T3: what was saved before M39 gets its refs from the backfill
  it("the backfill gives versions saved before M39 their refs", async () => {
    const app = (await agent.post("/api/apps").send({ source: APP() }).expect(201)).body as { appId: string };
    const saver = await create(SAVER());
    const after = await create(
      `name: After\napp: Shelf\ntrigger: { on: run.finished, pipeline: Books in }\nsteps:\n  - id: note\n    type: llm.generate\n    with: { instruction: "Say hi" }\n`,
    );
    const withButton = APP().replace(
      "      title: { type: text }\n",
      "      title: { type: text }\npages:\n  - list: Book\n    actions:\n      - { label: Fetch now, run: Books in }\n",
    );
    await agent.put(`/api/apps/${app.appId}`).send({ source: withButton }).expect(200);
    // As they were before M39.
    await db.client.$executeRawUnsafe(`UPDATE "PipelineVersions" SET definition = definition - 'refs'`);
    await db.client.$executeRawUnsafe(`UPDATE "AppVersions" SET refs = NULL`);

    const sql = readFileSync(BACKFILL, "utf8").replace(/^--.*$/gm, "");
    for (const statement of sql.split(/;\s*\n/).filter((s) => s.trim())) await db.client.$executeRawUnsafe(statement);

    const definitionOf = async (pipelineId: string) => {
      const p = await db.client.pipeline.findUniqueOrThrow({ where: { pipelineId } });
      return (await db.client.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId: p.currentVersionId! } })).definition as {
        refs: unknown;
      };
    };
    expect((await definitionOf(after.pipelineId)).refs).toEqual({ appId: app.appId, pipelines: { "Books in": saver.pipelineId } });
    expect((await definitionOf(saver.pipelineId)).refs).toEqual({ appId: app.appId, pipelines: {} });
    const appVersion = await db.client.appVersion.findFirstOrThrow({ where: { appId: app.appId }, orderBy: { version: "desc" } });
    expect(appVersion.refs).toEqual({ pipelines: { "Books in": saver.pipelineId } });
  });
});

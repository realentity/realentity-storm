import { createPrismaConnection, type PrismaConnection } from "@ai-me/db";
import {
  type AppCheckView,
  type AppDetailView,
  type AppSaveRefusal,
  type AppSummaryView,
  type DraftTypeView,
  type EntityListView,
  type PipelineDetailView,
} from "@ai-me/shared";
import { TestEnvironment } from "@ai-me/testing";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

const APP = `
name: Job Search
icon: briefcase
types:
  Job:
    key: url
    title: position
    fields:
      url: { type: url, required: true }
      position: { type: text, required: true }
      company: { type: text }
      salary: { type: money, currency: currency }
      currency: { type: text }
      favorite: { type: yesno, mine: true }
`;

const DISCOVERY = `
name: Job discovery
app: Job Search
policy: { allowedDomains: [jobs.example.com] }
steps:
  - id: feed
    type: http.fetch
    with: { url: "https://jobs.example.com/feed" }
  - id: save
    type: data.save
    with: { items: "{{feed.items}}", type: Job, fields: [salary] }
  - id: best
    type: data.read
    with: { type: Job, sort: -salary, limit: 3 }
  - id: tell
    type: notify.telegram
    forEach: "{{best.items}}"
    with: { text: "{{item.position}}: {{item.salary}} {{item.currency}}" }
`;

// M30: Apps and data types
describe("apps", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;
  let userId: string;

  beforeAll(async () => {
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.app.deleteMany();
    await db.client.$executeRaw`DELETE FROM pgboss.job`;
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  const createApp = async (source = APP) => (await agent.post("/api/apps").send({ source }).expect(201)).body as AppDetailView;

  it("keeps an App's versions, says what changed, and lists its types and pipelines", async () => {
    const app = await createApp();
    expect(app).toMatchObject({ name: "Job Search", icon: "briefcase", version: 1, types: [{ name: "Job", entities: 0 }], pipelines: [] });
    expect(app.source).toBe(APP);

    await agent.post("/api/pipelines").send({ source: DISCOVERY }).expect(201);
    const next = (
      await agent
        .put(`/api/apps/${app.appId}`)
        .send({ source: APP.replace("company: { type: text }", "company: { type: text }\n      remote: { type: yesno }") })
        .expect(200)
    ).body as AppDetailView;
    expect(next.version).toBe(2);
    expect(next.versions.map((v) => [v.version, v.changeSummary])).toEqual([
      [2, "Job.remote added (yesno)"],
      [1, null],
    ]);
    expect(next.pipelines).toEqual([expect.objectContaining({ name: "Job discovery", enabled: false })]);

    await agent
      .put(`/api/apps/${app.appId}`)
      .send({ source: APP.replace("company: { type: text }", "company: { type: text }\n      remote: { type: yesno }") })
      .expect(422);
    await agent.post("/api/apps").send({ source: APP }).expect(409);
    const invalid = await agent
      .post("/api/apps")
      .send({ source: "name: Bad\ntypes:\n  Job: { key: id, fields: { url: { type: url } } }" })
      .expect(400);
    expect((invalid.body as AppSaveRefusal).errors).toEqual([{ path: "types.Job.key", message: '"id" is not one of the fields', line: 3 }]);
  });

  it("compiles pipelines against their App: an unknown App, type or field is refused", async () => {
    await agent.post("/api/pipelines").send({ source: DISCOVERY }).expect(400);
    await createApp();
    const wrong = await agent
      .post("/api/pipelines")
      .send({ source: DISCOVERY.replace("{{item.salary}}", "{{item.salery}}") })
      .expect(400);
    expect((wrong.body as { errors: { message: string }[] }).errors[0]?.message).toContain('the item has no field "salery"');
    const created = (await agent.post("/api/pipelines").send({ source: DISCOVERY }).expect(201)).body as PipelineDetailView;
    expect(created.current?.definition.app).toBe("Job Search");
  });

  // M30-I2
  it("refuses a version that would break one of its pipelines, naming it", async () => {
    const app = await createApp();
    const pipeline = (await agent.post("/api/pipelines").send({ source: DISCOVERY }).expect(201)).body as PipelineDetailView;

    const refused = await agent
      .put(`/api/apps/${app.appId}`)
      .send({ source: APP.replace("      salary: { type: money, currency: currency }\n", "") })
      .expect(409);
    const body = refused.body as AppSaveRefusal;
    expect(body.message).toBe('It would break "Job discovery": change it first, or keep what they use');
    expect(body.pipelines).toEqual([
      {
        pipelineId: pipeline.pipelineId,
        name: "Job discovery",
        errors: expect.arrayContaining([
          expect.objectContaining({
            path: "steps[1].with.fields[0]",
            message: expect.stringContaining('Job has no field "salary"') as unknown,
          }),
        ]) as unknown,
      },
    ]);
    const renamed = await agent
      .put(`/api/apps/${app.appId}`)
      .send({ source: APP.replace("name: Job Search", "name: Jobs") })
      .expect(409);
    expect((renamed.body as AppSaveRefusal).pipelines?.[0]?.errors).toEqual([
      { path: "app", message: 'there is no App named "Job Search"' },
    ]);
    expect(((await agent.get(`/api/apps/${app.appId}`).expect(200)).body as AppDetailView).version).toBe(1);
  });

  // M35-I1: a draft checked as I edit it, nothing saved
  it("checks a draft: its problems at their lines, the pipelines it would break, what it changes", async () => {
    const app = await createApp();
    const pipeline = (await agent.post("/api/pipelines").send({ source: DISCOVERY }).expect(201)).body as PipelineDetailView;
    const check = async (source: string, appId?: string) =>
      (
        await agent
          .post("/api/apps/check")
          .send(appId ? { source, appId } : { source })
          .expect(201)
      ).body as AppCheckView;

    // Not YAML: its line.
    const broken = await check("name: Bills\ntypes:\n  Bill: { key: id\n");
    expect(broken.ok).toBe(false);
    expect(broken.errors[0]).toMatchObject({ path: "" });
    expect(broken.errors[0].line).toBeGreaterThanOrEqual(3);

    // Not a valid App: the path, and the line it is on (APP starts with an empty line).
    const invalid = await check(APP.replace("currency: currency }", "currency: price }"), app.appId);
    expect(invalid.errors).toEqual([expect.objectContaining({ path: "types.Job.fields.salary.currency", line: 12 })]);
    expect(invalid.pipelines).toEqual([]);

    // Valid, but it would break the pipeline: as Save would refuse it.
    const breaking = await check(APP.replace("      salary: { type: money, currency: currency }\n", ""), app.appId);
    expect(breaking.ok).toBe(false);
    expect(breaking.errors).toEqual([]);
    expect(breaking.pipelines).toEqual([
      expect.objectContaining({
        pipelineId: pipeline.pipelineId,
        errors: expect.arrayContaining([expect.objectContaining({ path: "steps[1].with.fields[0]" })]) as unknown,
      }),
    ]);
    await agent
      .put(`/api/apps/${app.appId}`)
      .send({ source: APP.replace("      salary: { type: money, currency: currency }\n", "") })
      .expect(409);

    // Fine: what it changes; nothing saved.
    const fine = await check(
      APP.replace("      company: { type: text }\n", "      company: { type: text }\n      city: { type: text }\n"),
      app.appId,
    );
    expect(fine).toMatchObject({ ok: true, errors: [], pipelines: [] });
    expect(fine.changes.join("\n")).toContain("city");
    expect(((await agent.get(`/api/apps/${app.appId}`).expect(200)).body as AppDetailView).version).toBe(1);

    // A new App: no changes to list; another user's App is not found.
    expect(await check(APP.replace("Job Search", "Job Hunt"))).toMatchObject({ ok: true, changes: [] });
    await agent.post("/api/apps/check").send({ source: APP, appId: "00000000-0000-4000-8000-000000000000" }).expect(404);
  });

  it("lists a type's entities, the removed ones apart", async () => {
    const app = await createApp();
    await db.client.dataEntity.createMany({
      data: [
        {
          appId: app.appId,
          type: "Job",
          key: "https://jobs.example.com/1",
          value: { url: "https://jobs.example.com/1", position: "Dev" },
          mine: { favorite: true },
        },
        {
          appId: app.appId,
          type: "Job",
          key: "https://jobs.example.com/2",
          value: { url: "https://jobs.example.com/2", position: "QA" },
          removedAt: new Date(),
        },
      ],
    });
    const list = (await agent.get(`/api/apps/${app.appId}/types/Job/entities`).expect(200)).body as EntityListView;
    expect(list).toMatchObject({
      app: "Job Search",
      type: "Job",
      total: 1,
      entities: [{ key: "https://jobs.example.com/1", mine: { favorite: true } }],
    });
    expect(((await agent.get(`/api/apps/${app.appId}/types/Job/entities?removed=true`).expect(200)).body as EntityListView).total).toBe(1);
    await agent.get(`/api/apps/${app.appId}/types/Nope/entities`).expect(404);
    expect(((await agent.get("/api/apps").expect(200)).body as AppSummaryView[])[0]?.types).toEqual([{ name: "Job", entities: 1 }]);
  });

  // M30-T7
  it("drafts a type from what a run's step gave", async () => {
    const pipeline = (
      await agent
        .post("/api/pipelines")
        .send({ source: "name: Feed\nsteps:\n  - { id: tell, type: notify.telegram, with: { text: hi } }" })
        .expect(201)
    ).body as PipelineDetailView;
    const run = await db.client.run.create({
      data: { userId, pipelineVersionId: pipeline.current!.pipelineVersionId, status: "DONE", trigger: "manual", dryRun: true },
    });
    await db.client.step.create({
      data: {
        runId: run.runId,
        stepKey: "feed",
        type: "http.fetch",
        status: "DONE",
        output: {
          status: 200,
          items: [1, 2, 3].map((n) => ({ link: `https://jobs.example.com/${n}`, title: `Job ${n}`, posted: `2026-11-0${n}` })),
        },
      },
    });
    const draft = (await agent.post("/api/apps/draft-type").send({ runId: run.runId, stepKey: "feed" }).expect(201)).body as DraftTypeView;
    expect(draft.samples).toBe(3);
    expect(draft.type.key).toBe("link");
    expect(draft.source).toBe(
      [
        "Item:",
        "  key: link",
        "  title: title",
        "  fields:",
        "    link:",
        "      type: url",
        "      required: true",
        "    title:",
        "      type: text",
        "      required: true",
        "    posted:",
        "      type: date",
        "      required: true",
        "",
      ].join("\n"),
    );
    await agent.post("/api/apps/draft-type").send({ runId: run.runId, stepKey: "nope" }).expect(404);
  });

  // M35-T4
  it("drafts a type from a sample I paste: a list, an object holding one, or one item", async () => {
    const items = [
      { id: "a", name: "WD Purple 8TB", price: "399", currency: "BGN", url: "https://shop.example.org/a" },
      { id: "b", name: "Seagate SkyHawk 8TB", price: 419.5, currency: "BGN", url: "https://shop.example.org/b" },
    ];
    const draft = async (sample: unknown) => (await agent.post("/api/apps/draft-type/sample").send({ sample }).expect(201)).body as DraftTypeView;

    const fromList = await draft(items);
    expect(fromList.samples).toBe(2);
    expect(fromList.type.key).toBe("id");
    expect(fromList.type.fields.price).toMatchObject({ type: "money", currency: "currency" });
    expect(fromList.type.fields.url.type).toBe("url");
    expect(fromList.examples?.name).toEqual(["WD Purple 8TB", "Seagate SkyHawk 8TB"]);

    expect((await draft({ total: 2, results: items })).samples).toBe(2);
    expect((await draft(items[0])).samples).toBe(1);
    await agent.post("/api/apps/draft-type/sample").send({ sample: "just text" }).expect(422);
  });
});

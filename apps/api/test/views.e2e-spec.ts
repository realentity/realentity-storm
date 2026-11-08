import { createPrismaConnection, type Prisma, type PrismaConnection } from "@realentity/storm-db";
import {
  type PipelineDetailView,
  type RunDetailView,
  type ViewMenuItem,
  type ViewPageView,
  type ViewRow,
  type ViewRowView,
} from "@realentity/storm-shared";
import { TestEnvironment } from "@realentity/storm-testing";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

const RELEASES = `
name: Release watch
trigger: { schedule: "0 9 * * *", tz: Europe/Sofia }
policy: { allowedDomains: [github.com] }
steps:
  - id: feeds
    type: http.fetch
    with: { url: "https://github.com/acme/app/releases.atom" }
  - id: seen
    type: data.save
    with: { items: "{{feeds.items}}", collection: releases, key: id, complete: true }
  - id: stars
    type: data.history
    with: { items: "{{feeds.items}}", collection: release-stars, key: id, value: stars }
view:
  menu: { label: Releases, icon: package }
  collection: releases
  columns: [title, { field: stars, as: number }, { field: url, as: link }]
  sort: -stars
  removed: true
  detail: { history: release-stars }
  marks: [{ id: done, label: Done, hides: true }, { id: star, label: Star }]
  actions:
    - { label: Check now, run: self }
    - { label: Notes, run: Release notes, row: true }
    - { label: Wrong, run: Plain, row: true }
    - { label: Missing, run: Nobody }
`;

const NOTES = `
name: Release notes
trigger: { on: view.action, collection: releases }
steps:
  - id: notes
    type: llm.summarize
    with: { content: "{{trigger.item.title}}", instruction: "What changed" }
`;

const PLAIN = `
name: Plain
steps:
  - id: notes
    type: llm.summarize
    with: { content: "nothing", instruction: "nothing" }
`;

// M27: pipelines' pages
describe("views", () => {
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
    await db.client.dataRecord.deleteMany();
    await db.client.dataPoint.deleteMany();
    await db.client.userSetting.deleteMany();
    await db.client.$executeRaw`DELETE FROM pgboss.job`;
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  const create = async (source: string) => (await agent.post("/api/pipelines").send({ source }).expect(201)).body as PipelineDetailView;
  const release = (key: string, value: Prisma.InputJsonObject, removed = false) =>
    db.client.dataRecord.create({
      data: { userId, collection: "releases", key, value, removedAt: removed ? new Date() : null },
    });

  it("lists the pipelines with a page in the menu", async () => {
    const releases = await create(RELEASES);
    await create(PLAIN);
    // A draft's view isn't a page until it is saved.
    await agent
      .post("/api/pipelines/dry-run")
      .send({ source: RELEASES.replace("Release watch", "Draft watch") })
      .expect(202);
    expect((await agent.get("/api/views").expect(200)).body as ViewMenuItem[]).toEqual([
      { pipelineId: releases.pipelineId, pipelineName: "Release watch", label: "Releases", icon: "package" },
    ]);
    await agent.get(`/api/views/${(await create(PLAIN.replace("Plain", "Plain two"))).pipelineId}`).expect(404);
  });

  it("shows the rows as the view says: sorted, searched, paged, by tab", async () => {
    const { pipelineId } = await create(RELEASES);
    await release("v1", { title: "v1.0.0", stars: 5, url: "https://github.com/acme/app/releases/tag/v1" });
    await release("v2", { title: "v2.0.0", stars: 40 });
    await release("v3", { title: "v3.0.0-rc.1", stars: 12 });
    await release("v0", { title: "v0.9.0", stars: 1 }, true);
    await db.client.dataRecord.create({ data: { userId, collection: "other", key: "x", value: { title: "not mine" } } });

    const page = (await agent.get(`/api/views/${pipelineId}`).expect(200)).body as ViewPageView;
    expect(page.rows.map((r) => r.key)).toEqual(["v2", "v3", "v1"]);
    expect(page.counts).toEqual({ current: 3, removed: 1, "mark:done": 0, "mark:star": 0 });
    expect(page.view.columns[1]).toEqual({ field: "stars", as: "number" });
    expect(page.rows[2]).toMatchObject({ value: { title: "v1.0.0" }, marks: {}, removedAt: null });

    const search = (await agent.get(`/api/views/${pipelineId}?q=RC`).expect(200)).body as ViewPageView;
    expect(search.rows.map((r) => r.key)).toEqual(["v3"]);
    const paged = (await agent.get(`/api/views/${pipelineId}?offset=1&limit=1`).expect(200)).body as ViewPageView;
    expect([paged.rows.map((r) => r.key), paged.total]).toEqual([["v3"], 3]);
    const removed = (await agent.get(`/api/views/${pipelineId}?tab=removed`).expect(200)).body as ViewPageView;
    expect(removed.rows.map((r) => r.key)).toEqual(["v0"]);
    await agent.get(`/api/views/${pipelineId}?tab=mark:nothing`).expect(404);
    await agent.get(`/api/views/${pipelineId}?limit=5000`).expect(400);
  });

  it("keeps the user's marks: a hiding mark moves the row to its tab, and back", async () => {
    const { pipelineId } = await create(RELEASES);
    await release("v1", { title: "v1.0.0", stars: 5 });
    await release("v2", { title: "v2.0.0", stars: 40 });

    const marked = (await agent.put(`/api/views/${pipelineId}/rows/v1/marks/done`).send({ on: true }).expect(200)).body as ViewRow;
    expect(Object.keys(marked.marks)).toEqual(["done"]);
    await agent.put(`/api/views/${pipelineId}/rows/v2/marks/star`).send({ on: true }).expect(200);
    const page = (await agent.get(`/api/views/${pipelineId}`).expect(200)).body as ViewPageView;
    expect([page.rows.map((r) => r.key), page.counts]).toEqual([["v2"], { current: 1, removed: 0, "mark:done": 1, "mark:star": 1 }]);
    expect(((await agent.get(`/api/views/${pipelineId}?tab=mark:done`).expect(200)).body as ViewPageView).rows.map((r) => r.key)).toEqual([
      "v1",
    ]);

    // A save of the row's value (what data.save does) leaves the marks alone.
    await db.client.dataRecord.update({
      where: { userId_collection_key: { userId, collection: "releases", key: "v1" } },
      data: { value: { title: "v1.0.1" } },
    });
    const again = (await agent.get(`/api/views/${pipelineId}/rows/v1`).expect(200)).body as ViewRowView;
    expect([again.row.value, Object.keys(again.row.marks)]).toEqual([{ title: "v1.0.1" }, ["done"]]);

    await agent.put(`/api/views/${pipelineId}/rows/v1/marks/done`).send({ on: false }).expect(200);
    expect(((await agent.get(`/api/views/${pipelineId}`).expect(200)).body as ViewPageView).counts.current).toBe(2);
    await agent.put(`/api/views/${pipelineId}/rows/v1/marks/other`).send({ on: true }).expect(404);
    await agent.put(`/api/views/${pipelineId}/rows/nothing/marks/done`).send({ on: true }).expect(404);
    await agent.put(`/api/views/${pipelineId}/rows/v1/marks/done`).send({ on: "yes" }).expect(400);
  });

  it("shows one row with its history; a key with slashes works", async () => {
    const { pipelineId } = await create(RELEASES);
    const key = "tag:github.com,2008:Release/1";
    await release(key, { title: "v1.0.0", stars: 5 });
    await db.client.dataPoint.createMany({
      data: [
        { userId, collection: "release-stars", key, value: 3, at: new Date("2026-10-01T09:00:00Z") },
        { userId, collection: "release-stars", key, value: 5, at: new Date("2026-10-02T09:00:00Z") },
        { userId, collection: "release-stars", key: "other", value: 9 },
      ],
    });
    const row = (await agent.get(`/api/views/${pipelineId}/rows/${encodeURIComponent(key)}`).expect(200)).body as ViewRowView;
    expect(row.row.key).toBe(key);
    expect(row.history).toEqual([
      { at: "2026-10-01T09:00:00.000Z", value: 3 },
      { at: "2026-10-02T09:00:00.000Z", value: 5 },
    ]);
    await agent.get(`/api/views/${pipelineId}/rows/nothing`).expect(404);
  });

  it("M29-I8: a chart of every key above the list: the five highest by latest value, named by their row; none without `chart`", async () => {
    const plain = await create(RELEASES);
    expect(((await agent.get(`/api/views/${plain.pipelineId}`).expect(200)).body as ViewPageView).chart).toBeNull();
    await db.client.pipeline.delete({ where: { pipelineId: plain.pipelineId } });

    const { pipelineId } = await create(RELEASES.replace("  detail: { history: release-stars }", "  detail: { history: release-stars }\n  chart: { history: release-stars, label: Stars }"));
    await release("r1", { title: "v1.0.0", stars: 5 });
    const day = (n: number) => new Date(`2026-10-0${n}T09:00:00Z`);
    await db.client.dataPoint.createMany({
      data: [
        { userId, collection: "release-stars", key: "r1", value: 3, at: day(1) },
        { userId, collection: "release-stars", key: "r1", value: 50, at: day(2) },
        ...[1, 2, 3, 4, 5, 6].map((n) => ({ userId, collection: "release-stars", key: `k${n}`, value: n, at: day(2) })),
        { userId, collection: "other", key: "r1", value: 1000, at: day(2) },
      ],
    });
    const page = (await agent.get(`/api/views/${pipelineId}`).expect(200)).body as ViewPageView;
    expect(page.chart?.series.map((s) => [s.key, s.label, s.points.map((p) => p.value)])).toEqual([
      ["r1", "v1.0.0", [3, 50]],
      ["k6", "k6", [6]],
      ["k5", "k5", [5]],
      ["k4", "k4", [4]],
      ["k3", "k3", [3]],
    ]);
    expect(page.chart?.more).toBe(2);
    expect(page.chart?.series[0]?.points[0]).toEqual({ at: "2026-10-01T09:00:00.000Z", value: 3 });
  });

  it("starts pipelines from its buttons: the page's as a manual run, a row's with the row", async () => {
    const { pipelineId } = await create(RELEASES);
    const notes = await create(NOTES);
    await create(PLAIN);
    await release("v1", { title: "v1.0.0", stars: 5 });

    const own = (await agent.post(`/api/views/${pipelineId}/actions/0`).send({}).expect(202)).body as RunDetailView;
    expect(own).toMatchObject({ pipelineId, trigger: "manual", dryRun: false });

    const run = (await agent.post(`/api/views/${pipelineId}/actions/1`).send({ key: "v1" }).expect(202)).body as RunDetailView;
    expect(run).toMatchObject({ pipelineId: notes.pipelineId, trigger: "view" });
    expect((await db.client.run.findUniqueOrThrow({ where: { runId: run.runId } })).triggerData).toEqual({
      collection: "releases",
      key: "v1",
      item: { title: "v1.0.0", stars: 5 },
      action: "Notes",
    });

    await agent.post(`/api/views/${pipelineId}/actions/1`).send({}).expect(400);
    await agent.post(`/api/views/${pipelineId}/actions/1`).send({ key: "nothing" }).expect(404);
    expect(
      ((await agent.post(`/api/views/${pipelineId}/actions/2`).send({ key: "v1" }).expect(409)).body as { message: string }).message,
    ).toMatch(/isn't triggered by/);
    await agent.post(`/api/views/${pipelineId}/actions/3`).send({}).expect(404);
    await agent.post(`/api/views/${pipelineId}/actions/9`).send({}).expect(404);

    // Another collection's pipeline doesn't take these rows.
    await agent
      .post(`/api/pipelines/${notes.pipelineId}/versions`)
      .send({ source: NOTES.replace("collection: releases", "collection: other") })
      .expect(201);
    expect(
      ((await agent.post(`/api/views/${pipelineId}/actions/1`).send({ key: "v1" }).expect(409)).body as { message: string }).message,
    ).toMatch(/takes rows of "other"/);

    // The kill switch holds.
    await agent.put("/api/kill-switch").send({ engaged: true }).expect(200);
    await agent.post(`/api/views/${pipelineId}/actions/0`).send({}).expect(409);
  });
});

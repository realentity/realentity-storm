import { exampleYaml } from "@realentity/storm-shared/example-files";
import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { type AppDetailView, type AppImportResult, type AppListView } from "@realentity/storm-shared";
import { TestEnvironment } from "@realentity/storm-testing";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

const RELEASES_APP = exampleYaml("apps/releases.yaml");
const TABLES_APP = exampleYaml("apps/tables.yaml");

// M33-T5: what a pipeline outside an App kept in a collection, moved into one of an App's types
describe("moving a collection into an App", () => {
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
    await db.client.app.deleteMany();
    await db.client.dataPoint.deleteMany();
    await db.client.dataRecord.deleteMany();
    await db.client.$executeRaw`DELETE FROM pgboss.job`;
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  // M33-T5: a collection a pipeline's data.save kept, into an App's type
  it("moves a collection into a type, a mark as the yes/no field (mine) of its name; a list draws its history chart", async () => {
    const release = (id: string, title: string, marks: Record<string, string> = {}, removedAt: Date | null = null) =>
      db.client.dataRecord.create({
        data: { userId, collection: "releases", key: id, value: { id, title, published: "2026-11-01T10:00:00Z", url: `https://github.com/acme/app/releases/${id}` }, marks, removedAt },
      });
    await release("v1", "v1.0.0", { upgraded: "2026-11-02T10:00:00.000Z" });
    await release("v2", "v2.0.0");
    await release("v0", "v0.9.0", {}, new Date());
    await db.client.dataRecord.create({ data: { userId, collection: "releases", key: "bad", value: { title: "no id" } } });

    const app = (await agent.post("/api/apps").send({ source: RELEASES_APP }).expect(201)).body as AppDetailView;
    expect(app.imports).toEqual([{ from: "collection", collection: "releases", label: 'the "releases" collection', count: 4 }]);
    await agent.post(`/api/apps/${app.appId}/import`).send({ from: "collection", collection: "releases" }).expect(400);
    const moved = (await agent.post(`/api/apps/${app.appId}/import`).send({ from: "collection", collection: "releases", type: "Release" }).expect(201)).body as AppImportResult;
    expect(moved).toEqual({ moved: 3, skipped: 1 });
    const releases = await db.client.dataEntity.findMany({ where: { appId: app.appId, type: "Release" }, orderBy: { key: "asc" } });
    expect(releases.map((r) => [r.key, r.mine, r.removedAt !== null])).toEqual([
      ["v0", {}, true],
      ["v1", { upgraded: true }, false],
      ["v2", {}, false],
    ]);
    expect(releases[1]?.value).toMatchObject({ published: "2026-11-01T10:00:00.000Z", url: "https://github.com/acme/app/releases/v1" });

    const tables = (await agent.post("/api/apps").send({ source: TABLES_APP }).expect(201)).body as AppDetailView;
    await db.client.dataEntity.createMany({ data: [{ appId: tables.appId, type: "Table", key: "orders", value: { name: "orders", rows: 120 } }] });
    await db.client.dataPoint.createMany({
      data: [100, 120].map((value, i) => ({ userId, collection: "table-rows", key: "orders", value, at: new Date(Date.UTC(2026, 10, 1, i)) })),
    });
    const list = (await agent.get(`/api/apps/${tables.appId}/pages/Table`).expect(200)).body as AppListView;
    expect(list.chart).toEqual({ series: [{ key: "orders", label: "orders", points: [expect.objectContaining({ value: 100 }), expect.objectContaining({ value: 120 })] }], more: 0 });
  });

  // M71: only collections; the old pages' bills, prices and jobs are gone
  it("offers nothing to an App with only types of mine, refuses a collection it can't take, and the old sources", async () => {
    await db.client.dataRecord.create({ data: { userId, collection: "notes", key: "a", value: { id: "a" } } });
    const mine = JSON.stringify({ name: "Notes", types: { Note: { key: "id", mine: true, fields: { id: { type: "text" } } } } });
    const app = (await agent.post("/api/apps").send({ source: mine }).expect(201)).body as AppDetailView;
    expect(app.imports).toEqual([]);
    await agent.post(`/api/apps/${app.appId}/import`).send({ from: "collection", collection: "notes", type: "Note" }).expect(409);
    for (const from of ["bills", "prices", "jobs"]) await agent.post(`/api/apps/${app.appId}/import`).send({ from }).expect(400);
  });
});

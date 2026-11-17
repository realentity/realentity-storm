import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { type AppDetailView, type AppEntityView, type AppListView } from "@realentity/storm-shared";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

const APP = `
name: Lockbox refs
types:
  Project:
    mine: true
    key: name
    fields:
      name: { type: text, required: true }
  Entry:
    mine: true
    key: id
    title: name
    fields:
      id: { type: text, auto: true }
      name: { type: text, required: true }
      project: { type: ref, to: Project, required: true }
pages:
  - list: Entry
    filters: [project]
  - view: Project
    related:
      - { type: Entry, by: project, add: true }
`;

// M55-I1: a ref saved only to an entity that is there; a list filtered by it; what points at an entity, before deleting it
describe("references between an App's types", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;
  let appId: string;

  beforeAll(async () => {
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
  });

  beforeEach(async () => {
    appId = ((await agent.post("/api/apps").send({ source: APP }).expect(201)).body as AppDetailView).appId;
    for (const name of ["Acme", "Globex"]) await agent.post(`/api/apps/${appId}/pages/Project`).send({ values: { name } }).expect(201);
  });

  afterEach(async () => {
    await db.client.app.deleteMany();
    await db.client.$executeRaw`DELETE FROM pgboss.job`;
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  const add = (values: Record<string, unknown>) => agent.post(`/api/apps/${appId}/pages/Entry`).send({ values });

  it("saves a ref only to one that is there, and filters a list by it, its choices the projects", async () => {
    const refused = await add({ name: "DB", project: "Initech" }).expect(400);
    expect((refused.body as { errors: unknown[] }).errors).toEqual([{ path: "project", message: "isn't one of the Projects" }]);
    await add({ name: "DB", project: "Acme" }).expect(201);
    await add({ name: "LOG", project: "Globex" }).expect(201);

    const list = (
      await agent
        .get(`/api/apps/${appId}/pages/Entry`)
        .query({ filter: JSON.stringify({ project: "Acme" }) })
        .expect(200)
    ).body as AppListView;
    expect(list.rows.map((r) => r.value.name)).toEqual(["DB"]);
    expect(list.page.filters).toEqual([
      expect.objectContaining({
        field: "project",
        ref: "Project",
        values: [
          { value: "Acme", label: "Acme" },
          { value: "Globex", label: "Globex" },
        ],
      }),
    ]);
  });

  it("says what points at an entity, and deletes it only when asked again", async () => {
    await add({ name: "DB", project: "Acme" }).expect(201);
    await add({ name: "LOG", project: "Acme" }).expect(201);
    const page = (await agent.get(`/api/apps/${appId}/pages/Project/Acme`).expect(200)).body as AppEntityView;
    expect(page.referencedBy).toEqual([{ type: "Entry", label: "Entry", count: 2 }]);
    expect(page.page.related).toEqual([expect.objectContaining({ type: "Entry", by: "project" })]);

    const refused = await agent.delete(`/api/apps/${appId}/pages/Project/Acme`).expect(409);
    expect((refused.body as { message: string }).message).toBe("2 Entrys point at it");
    await agent.delete(`/api/apps/${appId}/pages/Project/Acme`).query({ force: "true" }).expect(204);
    await agent.delete(`/api/apps/${appId}/pages/Project/Globex`).expect(204);
  });
});

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

const PATHS_APP = `
name: Lockbox paths
types:
  Project:
    mine: true
    key: name
    fields:
      name: { type: text, required: true }
  Path:
    mine: true
    key: id
    title: name
    fields:
      id: { type: text, auto: true }
      project: { type: ref, to: Project, required: true }
      name: { type: text, required: true }
  Entry:
    mine: true
    key: id
    title: name
    fields:
      id: { type: text, auto: true }
      name: { type: text, required: true }
      kind: { type: enum, values: [variable, secret], required: true }
      project: { type: ref, to: Project, required: true }
      path: { type: ref, to: Path, match: project, required: true }
      value: { type: longtext, required: true, when: { kind: variable } }
  Bundle:
    mine: true
    key: name
    fields:
      name: { type: text, required: true }
      project: { type: ref, to: Project, required: true }
      paths: { type: list, of: ref, to: Path, match: project, required: true }
pages:
  - list: Entry
    search: [name, path]
`;

// M56-I1: a ref among the ones matching another field, a list of refs, refs named by title, a field required by `when`
describe("matching refs and lists of refs", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;
  let appId: string;
  const paths: Record<string, string> = {};

  beforeAll(async () => {
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
  });

  beforeEach(async () => {
    appId = ((await agent.post("/api/apps").send({ source: PATHS_APP }).expect(201)).body as AppDetailView).appId;
    for (const name of ["Acme", "Globex"]) await agent.post(`/api/apps/${appId}/pages/Project`).send({ values: { name } }).expect(201);
    for (const [project, name] of [
      ["Acme", "/api"],
      ["Acme", "/_backend"],
      ["Globex", "/web"],
    ]) {
      const added = (await agent.post(`/api/apps/${appId}/pages/Path`).send({ values: { project, name } }).expect(201))
        .body as AppEntityView;
      paths[name] = added.row.key;
    }
  });

  afterEach(async () => {
    await db.client.app.deleteMany();
    await db.client.$executeRaw`DELETE FROM pgboss.job`;
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  const add = (type: string, values: Record<string, unknown>) => agent.post(`/api/apps/${appId}/pages/${type}`).send({ values });

  it("takes a path of the entry's project only, names it by its title, and asks for a value only of a variable", async () => {
    const other = await add("Entry", { name: "DB", kind: "secret", project: "Acme", path: paths["/web"] }).expect(400);
    expect((other.body as { errors: unknown[] }).errors).toEqual([{ path: "path", message: "isn't one of this project's Paths" }]);
    const noValue = await add("Entry", { name: "LOG", kind: "variable", project: "Acme", path: paths["/api"] }).expect(400);
    expect((noValue.body as { errors: unknown[] }).errors).toEqual([{ path: "value", message: "is required" }]);
    // A secret isn't asked for a variable's value.
    const db = (await add("Entry", { name: "DB", kind: "secret", project: "Acme", path: paths["/api"] }).expect(201)).body as AppEntityView;
    expect(db.row.titles).toEqual({ project: "Acme", path: "/api" });

    // Its project changed, the path it has isn't of it.
    const moved = await agent
      .put(`/api/apps/${appId}/pages/Entry/${db.row.key}/values`)
      .send({ values: { project: "Globex" } })
      .expect(400);
    expect((moved.body as { errors: unknown[] }).errors).toEqual([{ path: "path", message: "isn't one of this project's Paths" }]);

    const found = (await agent.get(`/api/apps/${appId}/pages/Entry`).query({ q: "/api" }).expect(200)).body as AppListView;
    expect(found.rows.map((r) => r.value.name)).toEqual(["DB"]);
  });

  it("keeps a bundle's paths in order, each its project's, and counts it as pointing at each", async () => {
    const other = await add("Bundle", { name: "b", project: "Acme", paths: `${paths["/_backend"]}\n${paths["/web"]}` }).expect(400);
    expect((other.body as { errors: unknown[] }).errors).toEqual([{ path: "paths", message: "isn't one of this project's Paths" }]);
    const bundle = (await add("Bundle", { name: "b", project: "Acme", paths: [paths["/_backend"], paths["/api"]] }).expect(201))
      .body as AppEntityView;
    expect(bundle.row.value.paths).toEqual([paths["/_backend"], paths["/api"]]);
    expect(bundle.row.titles).toEqual({ project: "Acme", paths: "/_backend, /api" });

    const path = (await agent.get(`/api/apps/${appId}/pages/Path/${paths["/api"]}`).expect(200)).body as AppEntityView;
    expect(path.referencedBy).toEqual([{ type: "Bundle", label: "Bundle", count: 1 }]);
  });
});

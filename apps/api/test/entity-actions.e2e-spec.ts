import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { QUEUES } from "@realentity/storm-queue";
import { type AppDetailView, type AppEntityView, type PipelineDetailView, type RunDetailView } from "@realentity/storm-shared";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

const APP = `
name: Job Search
types:
  Job:
    key: url
    title: title
    stages:
      field: status
      initial: new
      states: [new, favorite, applied, rejected]
      moves:
        - { from: new, to: [favorite, rejected] }
        - { from: favorite, to: [applied, rejected] }
    fields:
      url: { type: url, required: true }
      title: { type: text, required: true }
      favorite: { type: yesno, mine: true }
      comments: { type: longtext, mine: true }
      rating: { type: number, mine: true }
  Company:
    mine: true
    key: name
    fields:
      name: { type: text, required: true }
      email: { type: email }
pages:
  - form: Job
    fields: [comments, rating]
  - view: Job
    actions:
      - { label: Apply, run: Job submit, when: { status: favorite } }
      - { label: Wrong, run: Plain }
  - list: Job
    actions:
      - { label: Check now, run: Plain }
`;

const SUBMIT = `
name: Job submit
app: Job Search
trigger: { on: entity.action, type: Job }
steps:
  - id: tell
    type: notify.telegram
    with: { text: "Apply to {{trigger.item.title}}: {{trigger.item.comments}}" }
`;

const PLAIN = `
name: Plain
steps:
  - id: tell
    type: notify.telegram
    with: { text: "plain" }
`;

// M32-I1 (the user's half), S1: forms, stage moves, entities of a type of mine, buttons
describe("entity actions", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;
  let appId: string;
  const url = "https://jobs.test/1";
  const page = () => `/api/apps/${appId}/pages/Job/${encodeURIComponent(url)}`;

  beforeAll(async () => {
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
  });

  beforeEach(async () => {
    appId = ((await agent.post("/api/apps").send({ source: APP }).expect(201)).body as AppDetailView).appId;
    await db.client.dataEntity.create({
      data: {
        appId,
        type: "Job",
        key: url,
        value: { url, title: "Developer" },
        stage: "new",
        stageDates: { new: "2026-11-01T00:00:00.000Z" },
      },
    });
    await db.client.$executeRaw`DELETE FROM pgboss.job WHERE name = ${QUEUES.events}`;
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

  const events = () =>
    db.client.$queryRaw<
      { data: { data: Record<string, unknown> } }[]
    >`SELECT data FROM pgboss.job WHERE name = ${QUEUES.events} ORDER BY created_on`;

  it("saves the user's fields on the form, each as its kind, and tells the App's pipelines", async () => {
    const saved = (
      await agent
        .put(`${page()}/values`)
        .send({ values: { comments: "Looks good", rating: "4" } })
        .expect(200)
    ).body as AppEntityView;
    expect(saved.mine).toEqual({ comments: "Looks good", rating: 4 });
    expect(saved.row.value).toMatchObject({ title: "Developer", comments: "Looks good", rating: 4, status: "new" });
    expect((await events()).map((e) => e.data.data)).toEqual([
      expect.objectContaining({ app: "Job Search", type: "Job", key: url, changed: ["comments", "rating"], by: "me", stage: null }),
    ]);

    const cleared = (
      await agent
        .put(`${page()}/values`)
        .send({ values: { rating: null } })
        .expect(200)
    ).body as AppEntityView;
    expect(cleared.mine).toEqual({ comments: "Looks good" });

    // S1: only the user's fields, and only those on the form; each value as its kind.
    const wrong = await agent
      .put(`${page()}/values`)
      .send({ values: { title: "Hacked", favorite: true, rating: "lots" } })
      .expect(400);
    expect((wrong.body as { errors: unknown[] }).errors).toEqual([
      { path: "title", message: "isn't on this form" },
      { path: "favorite", message: "isn't on this form" },
      { path: "rating", message: "isn't a number" },
    ]);
    expect((await db.client.dataEntity.findFirstOrThrow({ where: { key: url } })).value).toEqual({ url, title: "Developer" });
  });

  it("moves the stage as the user's moves allow, keeping when it first reached each state", async () => {
    expect(((await agent.get(page()).expect(200)).body as AppEntityView).stage).toEqual({
      value: "new",
      moves: ["favorite", "rejected"],
      dates: { new: "2026-11-01T00:00:00.000Z" },
    });
    await agent.put(`${page()}/stage`).send({ to: "applied" }).expect(409);
    const moved = (await agent.put(`${page()}/stage`).send({ to: "favorite" }).expect(200)).body as AppEntityView;
    expect(moved.stage).toMatchObject({ value: "favorite", moves: ["applied", "rejected"] });
    expect(Object.keys(moved.stage!.dates)).toEqual(["new", "favorite"]);
    expect(moved.actions).toEqual([0, 1]);
    expect((await events()).map((e) => e.data.data)).toEqual([
      expect.objectContaining({ changed: ["status"], by: "me", stage: { from: "new", to: "favorite" } }),
    ]);
  });

  it("an entity's button starts its pipeline with the entity, only while `when` holds; a list's starts a manual run", async () => {
    const submit = (await agent.post("/api/pipelines").send({ source: SUBMIT }).expect(201)).body as PipelineDetailView;
    await agent.post("/api/pipelines").send({ source: PLAIN }).expect(201);
    await agent.post(`/api/apps/${appId}/actions/Job/0`).send({ key: url }).expect(409);
    await agent.put(`${page()}/stage`).send({ to: "favorite" }).expect(200);
    await agent
      .put(`${page()}/values`)
      .send({ values: { comments: "Ready" } })
      .expect(200);
    const run = (await agent.post(`/api/apps/${appId}/actions/Job/0`).send({ key: url }).expect(202)).body as RunDetailView;
    expect(run.pipelineId).toBe(submit.pipelineId);
    const stored = await db.client.run.findUniqueOrThrow({ where: { runId: run.runId } });
    expect([stored.trigger, stored.triggerData]).toEqual([
      "view",
      {
        app: "Job Search",
        type: "Job",
        key: url,
        item: { url, title: "Developer", status: "favorite", comments: "Ready" },
        action: "Apply",
      },
    ]);
    // Plain isn't triggered by entity.action.
    await agent.post(`/api/apps/${appId}/actions/Job/1`).send({ key: url }).expect(409);
    await agent.post(`/api/apps/${appId}/actions/Job/0`).send({}).expect(202);
    await agent.post(`/api/apps/${appId}/actions/Job/7`).send({}).expect(404);
  });

  it("adds, edits and deletes entities of a type of mine; never one pipelines write", async () => {
    const added = (
      await agent
        .post(`/api/apps/${appId}/pages/Company`)
        .send({ values: { name: "Acme", email: "JOBS@acme.test" } })
        .expect(201)
    ).body as AppEntityView;
    expect(added.row).toMatchObject({ key: "Acme", value: { name: "Acme", email: "jobs@acme.test" } });
    await agent
      .post(`/api/apps/${appId}/pages/Company`)
      .send({ values: { name: "Acme" } })
      .expect(409);
    await agent
      .post(`/api/apps/${appId}/pages/Company`)
      .send({ values: { email: "a@b.test" } })
      .expect(400);
    const edited = (
      await agent
        .put(`/api/apps/${appId}/pages/Company/Acme/values`)
        .send({ values: { email: "hr@acme.test" } })
        .expect(200)
    ).body as AppEntityView;
    expect(edited.row.value).toEqual({ name: "Acme", email: "hr@acme.test" });
    await agent
      .put(`/api/apps/${appId}/pages/Company/Acme/values`)
      .send({ values: { name: "Other" } })
      .expect(400);
    await agent.delete(`/api/apps/${appId}/pages/Company/Acme`).expect(204);
    await agent.get(`/api/apps/${appId}/pages/Company/Acme`).expect(404);

    await agent
      .post(`/api/apps/${appId}/pages/Job`)
      .send({ values: { url: "https://jobs.test/2", title: "x" } })
      .expect(409);
    await agent.delete(page()).expect(409);
  });

  // M45-I1, the user's half: a type pipelines write, added by hand too; what I set stays over what they write
  it("adds, edits, resets and deletes entities of a type pipelines write too, when its list adds by hand", async () => {
    const tasks = (
      await agent
        .post("/api/apps")
        .send({
          source: `
name: Tasks
types:
  Task:
    key: title
    fields:
      title: { type: text, required: true }
      due: { type: date }
      tag: { type: enum, values: [home, work] }
pages:
  - list: Task
    add: true
  - form: Task
    fields: [due, tag]
`,
        })
        .expect(201)
    ).body as AppDetailView;
    const at = `/api/apps/${tasks.appId}/pages/Task`;
    const added = (await agent.post(at).send({ values: { title: "Renew the passport", due: "2026-12-01" } }).expect(201)).body as AppEntityView;
    expect(added.row.value).toEqual({ title: "Renew the passport", due: "2026-12-01" });
    expect(added.page.remove).toBe(true);

    // A pipeline writes the same task: its tag and due date; my due date stays over its.
    await db.client.dataEntity.update({
      where: { appId_type_key: { appId: tasks.appId, type: "Task", key: "Renew the passport" } },
      data: { value: { title: "Renew the passport", due: "2026-12-15", tag: "home" } },
    });
    const task = `${at}/${encodeURIComponent("Renew the passport")}`;
    const read = (await agent.get(task).expect(200)).body as AppEntityView;
    expect(read.row.value).toEqual({ title: "Renew the passport", due: "2026-12-01", tag: "home" });
    expect(read.written).toEqual({ due: "2026-12-15" });

    // A field pipelines write, set on the form; then due reset to the pipeline's.
    const edited = (await agent.put(`${task}/values`).send({ values: { tag: "work" } }).expect(200)).body as AppEntityView;
    expect(edited.row.value).toMatchObject({ due: "2026-12-01", tag: "work" });
    expect(edited.written).toEqual({ due: "2026-12-15", tag: "home" });
    const reset = (await agent.put(`${task}/values`).send({ values: { due: null } }).expect(200)).body as AppEntityView;
    expect(reset.row.value).toMatchObject({ due: "2026-12-15", tag: "work" });
    expect(reset.written).toEqual({ tag: "home" });

    // The key isn't on the form; a title missing can't be added.
    await agent.put(`${task}/values`).send({ values: { title: "Other" } }).expect(400);
    await agent.post(at).send({ values: { due: "2026-12-01" } }).expect(400);
    await agent.delete(task).expect(204);
    await agent.get(task).expect(404);
  });

  // M48: a key Storm makes: a task added without one, its title renamed
  it("makes the key of a type whose key is auto; the title can change", async () => {
    const tasks = (
      await agent
        .post("/api/apps")
        .send({
          source: `
name: Todo
types:
  Task:
    key: id
    title: title
    fields:
      id: { type: text, auto: true }
      title: { type: text, required: true }
pages:
  - list: Task
    add: true
  - form: Task
    fields: [title]
`,
        })
        .expect(201)
    ).body as AppDetailView;
    const at = `/api/apps/${tasks.appId}/pages/Task`;
    const list = (await agent.get(at).expect(200)).body as { page: { create: { field: string }[] } };
    expect(list.page.create.map((f) => f.field)).toEqual(["title"]);
    const added = (await agent.post(at).send({ values: { title: "Renew the passport" } }).expect(201)).body as AppEntityView;
    expect(added.row.key).toMatch(/^[a-z0-9]{12}$/);
    const renamed = (await agent.put(`${at}/${added.row.key}/values`).send({ values: { title: "Renew the passport and the ID" } }).expect(200)).body as AppEntityView;
    expect(renamed.row).toMatchObject({ key: added.row.key, value: { id: added.row.key, title: "Renew the passport and the ID" } });
    await agent.post(at).send({ values: { id: "mine", title: "x" } }).expect(400);
  });
});

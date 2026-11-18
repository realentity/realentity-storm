import { exampleFiles } from "@realentity/storm-shared/example-files";
import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { type AppDetailView, type BindingView, type CredentialView, type PipelineDetailView } from "@realentity/storm-shared";
import { readExamples, type ChecklistView } from "@realentity/storm-shared";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

const OPS = (name: string) => `
name: ${name}
types:
  Incident:
    key: id
    fields: { id: { type: text } }
needs:
  github: { kind: credential, type: api_key, for: api.github.com, label: "GitHub, to open issues" }
  database: { kind: credential, type: database, label: "The database to check" }
  repository: { kind: text, label: "Repository", example: me/infra }
`;

const ISSUE = (app: string) => `
name: Issue ${app}
app: ${app}
steps:
  - id: issue
    type: http.request
    with:
      method: POST
      url: "https://api.github.com/repos/{{setting.repository}}/issues"
      headers: { Authorization: "Bearer {{cred:github}}" }
      body: { title: Down }
  - id: rows
    type: db.query
    with: { connection: "{{cred:database}}", sql: "SELECT 1" }
  - id: feed
    type: http.fetch
    with: { url: "https://status.example.org/feed", headers: { X-Key: "{{cred:status}}" } }
policy: { allowedDomains: [status.example.org] }
`;

// M50-I1 (the api's half), S1: slots filled by id, per install; never by a credential's name
describe("bindings", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;

  beforeAll(async () => {
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
  });

  afterEach(async () => {
    await db.client.pipeline.deleteMany();
    await db.client.app.deleteMany();
    await db.client.credential.deleteMany();
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  const credential = async (name: string, kind: string, allowedHosts: string[], secret = "s3cret-value") =>
    (await agent.post("/api/credentials").send({ name, kind, allowedHosts, secret }).expect(201)).body as CredentialView;
  const slots = (views: BindingView[]) =>
    Object.fromEntries(views.map((v) => [v.slot, v.credential?.name ?? v.text ?? null]));

  it("fills a slot one credential alone fits; two installs filled each their own; a credential that doesn't fit refused", async () => {
    const token = await credential("my-token", "API_KEY", ["api.github.com"]);
    const prod = await credential("prod-db", "DATABASE", ["db.example.com"], "postgresql://reader:pw@db.example.com:5432/app");
    const staging = await credential("staging-db", "DATABASE", ["staging.example.com"], "postgresql://reader:pw@staging.example.com:5432/app");

    // One GitHub key fits: filled. Two databases fit: left for the user.
    const first = (await agent.post("/api/apps").send({ source: OPS("Ops one") }).expect(201)).body as AppDetailView;
    const second = (await agent.post("/api/apps").send({ source: OPS("Ops two") }).expect(201)).body as AppDetailView;
    expect(slots((await agent.get(`/api/apps/${first.appId}/bindings`).expect(200)).body as BindingView[])).toEqual({ github: "my-token", database: null, repository: null });

    await agent.put(`/api/apps/${first.appId}/bindings`).send({ database: { credentialId: prod.credentialId }, repository: { text: "me/infra" } }).expect(200);
    await agent.put(`/api/apps/${second.appId}/bindings`).send({ database: { credentialId: staging.credentialId }, repository: { text: "me/web" } }).expect(200);
    expect(slots((await agent.get(`/api/apps/${second.appId}/bindings`).expect(200)).body as BindingView[])).toEqual({ github: "my-token", database: "staging-db", repository: "me/web" });

    // A pipeline of the App: its own slot (status), and its App's.
    const pipeline = (await agent.post("/api/pipelines").send({ source: ISSUE("Ops one") }).expect(201)).body as PipelineDetailView;
    const views = (await agent.get(`/api/pipelines/${pipeline.pipelineId}/bindings`).expect(200)).body as BindingView[];
    expect(views.map((v) => [v.slot, v.owner, v.credential?.name ?? v.text ?? null])).toEqual([
      ["status", "pipeline", null],
      ["github", "app", "my-token"],
      ["database", "app", "prod-db"],
      ["repository", "app", "me/infra"],
    ]);
    expect(views[0].need).toEqual({ kind: "credential", for: "status.example.org" });

    // What doesn't fit, or isn't a slot, or isn't the pipeline's own: refused, nothing set.
    const refused = await agent.put(`/api/apps/${first.appId}/bindings`).send({ database: { credentialId: token.credentialId }, repository: { credentialId: prod.credentialId }, nope: { text: "x" } }).expect(400);
    expect((refused.body as { errors: { path: string; message: string }[] }).errors).toEqual([
      { path: "database", message: "my-token doesn't fit: a database" },
      { path: "repository", message: "takes text, not a credential" },
      { path: "nope", message: "isn't one of its slots" },
    ]);
    await agent.put(`/api/pipelines/${pipeline.pipelineId}/bindings`).send({ github: { credentialId: token.credentialId } }).expect(400);

    // A renamed credential stays where it is bound; cleared, the slot is empty again.
    await db.client.credential.update({ where: { credentialId: prod.credentialId }, data: { name: "production" } });
    expect(slots((await agent.get(`/api/apps/${first.appId}/bindings`).expect(200)).body as BindingView[])).toMatchObject({ database: "production" });
    await agent.put(`/api/apps/${first.appId}/bindings`).send({ database: { credentialId: null } }).expect(200);
    expect(slots((await agent.get(`/api/apps/${first.appId}/bindings`).expect(200)).body as BindingView[])).toMatchObject({ database: null });
  });

  // M50-T12: a pipeline's own slot made its App's, with what fills it; the App's other pipelines share it
  it("moves a pipeline's own slot up to its App, with its credential, as the next version of each", async () => {
    const feed = await credential("status-key", "API_KEY", ["status.example.org"]);
    const app = (await agent.post("/api/apps").send({ source: OPS("Ops four") }).expect(201)).body as AppDetailView;
    const pipeline = (await agent.post("/api/pipelines").send({ source: ISSUE("Ops four") }).expect(201)).body as PipelineDetailView;
    expect(((await agent.get(`/api/pipelines/${pipeline.pipelineId}/bindings`).expect(200)).body as BindingView[])[0]).toMatchObject({
      slot: "status",
      owner: "pipeline",
      credential: { name: "status-key" },
    });

    const moved = (await agent.post(`/api/pipelines/${pipeline.pipelineId}/needs/status/app`).expect(201)).body as PipelineDetailView;
    expect(moved.current?.version).toBe(2);
    expect(moved.current?.definition.needs).toBeUndefined();
    const views = (await agent.get(`/api/pipelines/${pipeline.pipelineId}/bindings`).expect(200)).body as BindingView[];
    expect(views.find((v) => v.slot === "status")).toMatchObject({ owner: "app", need: { kind: "credential", for: "status.example.org" }, credential: { name: "status-key" } });
    const shared = (await agent.get(`/api/apps/${app.appId}/bindings`).expect(200)).body as BindingView[];
    expect(shared.find((v) => v.slot === "status")?.credential?.credentialId).toBe(feed.credentialId);
    const appVersion = await db.client.appVersion.findFirstOrThrow({ where: { appId: app.appId }, orderBy: { version: "desc" } });
    expect(appVersion.version).toBe(2);
    expect(appVersion.source).toMatch(/status: \{ ?kind: credential, for: status\.example\.org ?\}/);

    // Its App's, or not a slot of it: refused.
    await agent.post(`/api/pipelines/${pipeline.pipelineId}/needs/github/app`).expect(404);
    await agent.post(`/api/pipelines/${pipeline.pipelineId}/needs/nope/app`).expect(404);
  });

  it("never fills a slot with another user's credential, and shows no binding the user can't see", async () => {
    const app = (await agent.post("/api/apps").send({ source: OPS("Ops three") }).expect(201)).body as AppDetailView;
    await agent.put(`/api/apps/${app.appId}/bindings`).send({ github: { credentialId: "1b671a64-40d5-491e-99b0-da01e8a64ba1" } }).expect(400);
  });

  // M50-T6, T13, T14, T15
  describe("what keeps slots filled", () => {
    const serverOps = readExamples(exampleFiles()).find((e) => e.id === "server-ops")!;

    it("Server ops from the gallery: its slots on the checklist, a pipeline switched on only once they are filled, each credential's uses", async () => {
      await agent
        .post("/api/bundles")
        .send({ text: serverOps.text, example: { id: serverOps.id, needs: serverOps.needs } })
        .expect(201);
      const app = await db.client.app.findFirstOrThrow({ where: { name: "Server ops" } });
      const checklist = async () => (await agent.get(`/api/examples/apps/${app.appId}/checklist`).expect(200)).body as ChecklistView;
      expect((await checklist()).items.filter((i) => i.link === `/apps/${app.appId}#needs`).map((i) => i.label)).toEqual([
        'Choose the credential for "The database to check (a user that may only read)"',
        'Choose the credential for "GitHub, to open issues"',
        'Set "Repository for its issues (owner/name)"',
      ]);

      const check = await db.client.pipeline.findFirstOrThrow({ where: { name: "Server ops · Database check" } });
      const refused = await agent.patch(`/api/pipelines/${check.pipelineId}`).send({ enabled: true }).expect(409);
      expect((refused.body as { message: string }).message).toBe(
        `Fill in "The database to check (a user that may only read)", "GitHub, to open issues", "Repository for its issues (owner/name)" first (its Needs, on its page or its App's)`,
      );

      const db1 = await credential("orders-db", "DATABASE", ["db.example.com"], "postgresql://reader:pw@db.example.com:5432/app");
      const token = await credential("gh", "API_KEY", ["api.github.com"]);
      await agent
        .put(`/api/apps/${app.appId}/bindings`)
        .send({ database: { credentialId: db1.credentialId }, github: { credentialId: token.credentialId }, repository: { text: "me/infra" } })
        .expect(200);
      expect((await checklist()).items.some((i) => i.link === `/apps/${app.appId}#needs`)).toBe(false);
      await agent.patch(`/api/pipelines/${check.pipelineId}`).send({ enabled: true }).expect(200);

      const credentials = (await agent.get("/api/credentials").expect(200)).body as CredentialView[];
      expect(credentials.find((c) => c.name === "orders-db")!.usedBy).toEqual([{ owner: "app", id: app.appId, name: "Server ops", slot: "database" }]);
    });

    it("a slot renamed in a new version keeps its binding when it asks for the same", async () => {
      const token = await credential("gh", "API_KEY", ["api.github.com"]);
      const source = (slot: string) => `
name: Renamed
needs:
  ${slot}: { kind: credential, type: api_key, for: api.github.com }
steps:
  - id: me
    type: http.request
    with: { method: POST, url: "https://api.github.com/user/repos", headers: { Authorization: "Bearer {{cred:${slot}}}" }, body: {} }
`;
      const created = (await agent.post("/api/pipelines").send({ source: source("token") }).expect(201)).body as PipelineDetailView;
      expect(slots((await agent.get(`/api/pipelines/${created.pipelineId}/bindings`).expect(200)).body as BindingView[])).toEqual({ token: "gh" });
      await agent.post(`/api/pipelines/${created.pipelineId}/versions`).send({ source: source("github") }).expect(201);
      expect(slots((await agent.get(`/api/pipelines/${created.pipelineId}/bindings`).expect(200)).body as BindingView[])).toEqual({ github: "gh" });
      expect(token.usedBy).toEqual([]);
    });
  });
});

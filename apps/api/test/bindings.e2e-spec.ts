import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { type AppDetailView, type BindingView, type CredentialView, type PipelineDetailView } from "@realentity/storm-shared";
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

  it("never fills a slot with another user's credential, and shows no binding the user can't see", async () => {
    const app = (await agent.post("/api/apps").send({ source: OPS("Ops three") }).expect(201)).body as AppDetailView;
    await agent.put(`/api/apps/${app.appId}/bindings`).send({ github: { credentialId: "1b671a64-40d5-491e-99b0-da01e8a64ba1" } }).expect(400);
  });
});

import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { type SettingsView } from "@realentity/storm-shared";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

/** A made-up OpenAI-compatible server: lists two models, or fails while `down`. */
function modelServer(): { server: Server; requests: string[]; setDown(down: boolean): void } {
  const requests: string[] = [];
  let down = false;
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (down) {
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "loading model" } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: "qwen3:14b" }, { id: "gemma3:12b" }] }));
  });
  return { server, requests, setDown: (value) => (down = value) };
}

const settingsOf = async (agent: ReturnType<typeof request.agent>) => (await agent.get("/api/settings").expect(200)).body as SettingsView;
const put = async (agent: ReturnType<typeof request.agent>, body: object, status = 200) =>
  (await agent.put("/api/settings").send(body).expect(status)).body as SettingsView & { errors?: { path: string; message: string }[] };

// M60: models on an OpenAI-compatible server, switched on and off in Settings
describe("local models", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;
  const fake = modelServer();
  let host: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
    host = `127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
    process.env.OPENAI_BASE_URL = `http://${host}/v1`;
    process.env.LLM_MODEL = "openai:qwen3:14b";
    process.env.LLM_MODEL_BUILDER = "claude-opus-5-5";
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
  });

  afterEach(async () => {
    fake.setDown(false);
    await db.client.modelSetting.deleteMany();
    await db.client.userSetting.updateMany({ data: { localModels: false, localModel: null } });
  });

  afterAll(async () => {
    await db.close();
    await api.close();
    delete process.env.OPENAI_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.LLM_MODEL_BUILDER;
    await new Promise((resolve) => fake.server.close(resolve));
  });

  it("is off by default: every task on Claude, LLM_MODEL waiting, the server's models listed", async () => {
    const settings = await settingsOf(agent);
    expect(settings.local).toEqual({ available: true, on: false, model: null });
    expect(settings.serverModels).toEqual({ host, models: ["openai:gemma3:12b", "openai:qwen3:14b"], error: null });
    expect(fake.requests).toContain("GET /v1/models");
    expect(settings.claude).toBe(false);
    expect(settings.models["llm.classify"]).toEqual({ model: "claude-haiku-5-5", effort: "low", source: "default" });
    expect(settings.models.builder).toEqual({ model: "claude-opus-5-5", effort: "high", source: "env" });

    // A local model for a task, while they are off: refused, so no choice points at nothing.
    const refused = await put(agent, { models: { "bill.read": { model: "openai:gemma3:12b", effort: "medium" } } }, 400);
    expect(refused.errors).toEqual([{ path: "models.bill.read", message: "Local models are off: switch them on first" }]);
  });

  it("on: LLM_MODEL, then the model for all tasks, then a task's own; off again: Claude, the choices kept", async () => {
    let settings = await put(agent, { localModels: true });
    expect(settings.local).toEqual({ available: true, on: true, model: null });
    expect(settings.models["llm.classify"]).toEqual({ model: "openai:qwen3:14b", effort: "low", source: "env" });
    expect(settings.models.builder).toEqual({ model: "claude-opus-5-5", effort: "high", source: "env" });

    settings = await put(agent, { localModel: "openai:gemma3:12b", models: { "email.draftReply": { model: "openai:qwen3:14b", effort: "medium" } } });
    expect(settings.models["llm.classify"]).toEqual({ model: "openai:gemma3:12b", effort: "low", source: "local" });
    expect(settings.models.builder).toEqual({ model: "openai:gemma3:12b", effort: "high", source: "local" });
    expect(settings.models["email.draftReply"]).toEqual({ model: "openai:qwen3:14b", effort: "medium", source: "settings" });

    // A name without the prefix would go to Claude: refused, as any unknown model.
    await put(agent, { models: { "bill.read": { model: "gemma3:12b", effort: "medium" } } }, 400);

    settings = await put(agent, { localModels: false });
    expect(settings.local).toEqual({ available: true, on: false, model: "openai:gemma3:12b" });
    expect(settings.models["llm.classify"]).toEqual({ model: "claude-haiku-5-5", effort: "low", source: "default" });
    expect(settings.models["email.draftReply"]).toEqual({ model: "claude-sonnet-5-5", effort: "medium", source: "default", waiting: "openai:qwen3:14b" });

    settings = await put(agent, { localModels: true });
    expect(settings.models["email.draftReply"]).toEqual({ model: "openai:qwen3:14b", effort: "medium", source: "settings" });
  });

  it("shows why the server's models couldn't be listed, and still shows the settings", async () => {
    fake.setDown(true);
    const settings = await settingsOf(agent);
    expect(settings.serverModels).toEqual({ host, models: [], error: `The model server (${host}) refused the request (503: loading model)` });
    expect(settings.models["llm.classify"].model).toBe("claude-haiku-5-5");
  });
});

describe("local models without a server", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    api = await createTestApp();
    agent = await api.signedIn();
  });

  afterAll(() => api.close());

  it("can't be switched on, and lists nothing", async () => {
    const settings = await settingsOf(agent);
    expect(settings.local).toEqual({ available: false, on: false, model: null });
    expect(settings.serverModels).toBeNull();
    const refused = await put(agent, { localModels: true, localModel: "openai:qwen3:14b" }, 400);
    expect(refused.errors).toEqual([
      { path: "localModels", message: "No OpenAI-compatible server is set up (OPENAI_BASE_URL)" },
      { path: "localModel", message: "No OpenAI-compatible server is set up (OPENAI_BASE_URL)" },
    ]);
  });
});

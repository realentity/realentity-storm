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

// M60: models on an OpenAI-compatible server, chosen in Settings
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
  });

  afterAll(async () => {
    await db.close();
    await api.close();
    delete process.env.OPENAI_BASE_URL;
    delete process.env.LLM_MODEL;
    delete process.env.LLM_MODEL_BUILDER;
    await new Promise((resolve) => fake.server.close(resolve));
  });

  it("lists the server's models, uses LLM_MODEL where no group model is set, and takes a server model per task", async () => {
    const settings = (await agent.get("/api/settings").expect(200)).body as SettingsView;
    expect(settings.serverModels).toEqual({ host, models: ["openai:gemma3:12b", "openai:qwen3:14b"], error: null });
    expect(settings.claude).toBe(false);
    expect(fake.requests).toContain("GET /v1/models");
    expect(settings.models["llm.classify"]).toEqual({ model: "openai:qwen3:14b", effort: "low", source: "env" });
    expect(settings.models["email.draftReply"]).toEqual({ model: "openai:qwen3:14b", effort: "medium", source: "env" });
    expect(settings.models.builder).toEqual({ model: "claude-opus-5-5", effort: "high", source: "env" });

    const chosen = (
      await agent
        .put("/api/settings")
        .send({ models: { "bill.read": { model: "openai:gemma3:12b", effort: "medium" } } })
        .expect(200)
    ).body as SettingsView;
    expect(chosen.models["bill.read"]).toEqual({ model: "openai:gemma3:12b", effort: "medium", source: "settings" });

    // A name without the prefix would go to Claude: refused, as any unknown model.
    await agent
      .put("/api/settings")
      .send({ models: { "bill.read": { model: "gemma3:12b", effort: "medium" } } })
      .expect(400);
  });

  it("shows why the server's models couldn't be listed, and still shows the settings", async () => {
    fake.setDown(true);
    const settings = (await agent.get("/api/settings").expect(200)).body as SettingsView;
    expect(settings.serverModels).toEqual({ host, models: [], error: `The model server (${host}) refused the request (503: loading model)` });
    expect(settings.models["llm.classify"].model).toBe("openai:qwen3:14b");
  });
});

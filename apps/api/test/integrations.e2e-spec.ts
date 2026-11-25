import { KeyRing, openIntegration } from "@realentity/storm-crypto";
import { createPrismaConnection, Integrations, type PrismaConnection } from "@realentity/storm-db";
import { type IntegrationTestView, type IntegrationView, type SettingsView } from "@realentity/storm-shared";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { authenticator } from "otplib";
import type request from "supertest";
import { AuthService } from "../src/auth/auth.service";
import { createTestApp, type TestApp } from "./support/test-app";

/** A made-up OpenAI-compatible server: two models, and answers {"ok": true}; fails while `down`. */
function modelServer(): { server: Server; requests: string[]; setDown(down: boolean): void } {
  const requests: string[] = [];
  let down = false;
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url} ${req.headers.authorization ?? "-"}`);
    if (down) {
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "loading model" } }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"ok":true}' } }], usage: { prompt_tokens: 9, completion_tokens: 3 } }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: "qwen3:14b" }, { id: "gemma3:12b" }] }));
  });
  return { server, requests, setDown: (value) => (down = value) };
}

const KEY = "sk-ant-made-up-key-0123456789";

// M62: Claude and the model servers in Settings → AI; models chosen from them
describe("model servers", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;
  const fake = modelServer();
  let baseUrl: string;

  /** A fresh valid code: the test asks more often than a code changes, so the last one used is forgotten first. */
  const code = () => {
    const auth: unknown = api.app.get(AuthService);
    (auth as { lastAcceptedTotp: string | null }).lastAcceptedTotp = null;
    return authenticator.generate(api.totpSecret);
  };
  const settings = async () => (await agent.get("/api/settings").expect(200)).body as SettingsView;

  beforeAll(async () => {
    await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}/v1`;
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
    await clear(); // the database is shared: an earlier spec may have set up Claude
  });

  const clear = async () => {
    await db.client.modelSetting.deleteMany();
    await db.client.userSetting.updateMany({ data: { defaultModel: null, embeddingsIntegrationId: null, embeddingsModel: null, builderChatMaxTokens: null } });
    await db.client.integration.deleteMany();
    api.app.get(Integrations).forget();
  };

  afterEach(async () => {
    fake.setDown(false);
    await clear();
  });

  afterAll(async () => {
    await db.close();
    await api.close();
    await new Promise((resolve) => fake.server.close(resolve));
  });

  it("without a server: the built-in defaults, and no model can be chosen", async () => {
    const view = await settings();
    expect(view.servers).toEqual([]);
    expect(view.models["llm.classify"]).toEqual({ model: "claude-haiku-5-5", effort: "low", source: "built-in" });
    const refused = (await agent.put("/api/settings").send({ models: { "llm.classify": { model: "claude-sonnet-5-5", effort: "low" } } }).expect(400)).body as {
      errors: { path: string; message: string }[];
    };
    expect(refused.errors).toEqual([{ path: "models.llm.classify", message: "Claude isn't set up: add it under Model servers" }]);
  });

  it("keeps Claude's key sealed and write-only, and asks for the code to set it", async () => {
    await agent.post("/api/integrations").send({ kind: "CLAUDE", secret: KEY }).expect(400);
    await agent.post("/api/integrations").send({ kind: "CLAUDE", secret: KEY, code: "000000" }).expect(401);
    const created = (await agent.post("/api/integrations").send({ kind: "CLAUDE", secret: KEY, code: code() }).expect(201)).body as IntegrationView;
    expect(created).toMatchObject({ kind: "CLAUDE", name: "Claude", enabled: true, baseUrl: null, secretHint: "…6789" });
    expect(JSON.stringify(created)).not.toContain(KEY);
    const listed = (await agent.get("/api/integrations").expect(200)).text;
    expect(listed).not.toContain(KEY);

    const row = await db.client.integration.findUniqueOrThrow({ where: { integrationId: created.integrationId } });
    expect(Buffer.from(row.ciphertext!).toString("utf8")).not.toContain(KEY);
    const sealed = { ciphertext: row.ciphertext!, iv: row.iv!, authTag: row.authTag!, wrappedDek: row.wrappedDek!, keyVersion: row.keyVersion! };
    expect(openIntegration(KeyRing.fromEnv(process.env), created.integrationId, sealed)).toBe(KEY);

    // One Claude; a new key needs the code, a name doesn't.
    await agent.post("/api/integrations").send({ kind: "CLAUDE", secret: KEY, code: code() }).expect(409);
    await agent.patch(`/api/integrations/${created.integrationId}`).send({ secret: "sk-ant-another-made-up-key" }).expect(401);
    await agent.patch(`/api/integrations/${created.integrationId}`).send({ name: "Anthropic" }).expect(200);

    const view = await settings();
    expect(view.servers).toEqual([expect.objectContaining({ kind: "CLAUDE", name: "Anthropic", enabled: true, error: null })]);
    expect(view.servers[0].models.map((m) => m.id)).toContain("claude-sonnet-5-5");
    await agent.put("/api/settings").send({ models: { "llm.classify": { model: "claude-sonnet-5-5", effort: "low" } } }).expect(200);
  });

  it("a model server: its models by id, tested, chosen as the default and per task; off, they wait; removed, they go", async () => {
    await agent.post("/api/integrations").send({ kind: "OPENAI_COMPATIBLE", name: "Ollama", baseUrl }).expect(400);
    const server = (await agent.post("/api/integrations").send({ kind: "OPENAI_COMPATIBLE", name: "Ollama", baseUrl, code: code() }).expect(201))
      .body as IntegrationView;
    const id = (name: string) => `openai:${server.integrationId}:${name}`;

    let view = await settings();
    expect(view.servers).toEqual([
      {
        integrationId: server.integrationId,
        kind: "OPENAI_COMPATIBLE",
        name: "Ollama",
        enabled: true,
        models: [
          { id: id("gemma3:12b"), name: "gemma3:12b" },
          { id: id("qwen3:14b"), name: "qwen3:14b" },
        ],
        error: null,
      },
    ]);

    const tested = (await agent.post(`/api/integrations/${server.integrationId}/test`).send({ model: "qwen3:14b" }).expect(200)).body as IntegrationTestView;
    expect(tested).toMatchObject({ ok: true, models: ["gemma3:12b", "qwen3:14b"], model: "qwen3:14b", error: null });
    expect(fake.requests.some((r) => r.startsWith("POST /v1/chat/completions -"))).toBe(true);

    view = (await agent
      .put("/api/settings")
      .send({ defaultModel: id("qwen3:14b"), models: { "email.draftReply": { model: id("gemma3:12b"), effort: "medium" } } })
      .expect(200)).body as SettingsView;
    expect(view.models["llm.classify"]).toEqual({ model: id("qwen3:14b"), effort: "low", source: "default" });
    expect(view.models["email.draftReply"]).toEqual({ model: id("gemma3:12b"), effort: "medium", source: "settings" });
    // A model of a server that isn't set up: refused.
    await agent
      .put("/api/settings")
      .send({ defaultModel: "openai:00000000-0000-4000-8000-000000000000:qwen3:14b" })
      .expect(400);

    // Off (no code needed to switch it): the built-in defaults, the choices kept.
    await agent.patch(`/api/integrations/${server.integrationId}`).send({ enabled: false }).expect(200);
    view = await settings();
    expect(view.models["llm.classify"]).toEqual({ model: "claude-haiku-5-5", effort: "low", source: "built-in" });
    expect(view.models["email.draftReply"]).toEqual({ model: "claude-sonnet-5-5", effort: "medium", source: "built-in", waiting: id("gemma3:12b") });
    await agent.patch(`/api/integrations/${server.integrationId}`).send({ enabled: true }).expect(200);
    expect((await settings()).models["email.draftReply"].model).toBe(id("gemma3:12b"));

    // A new address needs the code.
    await agent.patch(`/api/integrations/${server.integrationId}`).send({ baseUrl: "http://127.0.0.1:9/v1" }).expect(401);

    await agent.delete(`/api/integrations/${server.integrationId}`).expect(204);
    view = await settings();
    expect(view.defaultModel).toBeNull();
    expect(view.models["email.draftReply"]).toEqual({ model: "claude-sonnet-5-5", effort: "medium", source: "built-in" });
  });

  it("says why a server's models couldn't be listed, and still shows the settings", async () => {
    await agent.post("/api/integrations").send({ kind: "OPENAI_COMPATIBLE", name: "Ollama", baseUrl, code: code() }).expect(201);
    fake.setDown(true);
    const view = await settings();
    expect(view.servers[0]).toMatchObject({ models: [], error: expect.stringContaining("refused the request (503: loading model)") as unknown });
    expect(view.models["llm.classify"].model).toBe("claude-haiku-5-5");
  });

  it("embeddings from a model server and its model; the builder's limit", async () => {
    const server = (await agent.post("/api/integrations").send({ kind: "OPENAI_COMPATIBLE", name: "OpenAI", baseUrl, secret: "sk-made-up-openai-key", code: code() }).expect(201))
      .body as IntegrationView;
    expect(server.secretHint).toBe("…-key");
    const claude = (await agent.post("/api/integrations").send({ kind: "CLAUDE", secret: KEY, code: code() }).expect(201)).body as IntegrationView;

    await agent.put("/api/settings").send({ embeddings: { integrationId: claude.integrationId, model: "x" } }).expect(400);
    const view = (await agent
      .put("/api/settings")
      .send({ embeddings: { integrationId: server.integrationId, model: "text-embedding-3-large" }, builderChatMaxTokens: 500_000 })
      .expect(200)).body as SettingsView;
    expect(view.embeddings).toEqual({ integrationId: server.integrationId, model: "text-embedding-3-large" });
    expect(view.builderChatMaxTokens).toBe(500_000);

    // The server's key goes to the server, as its bearer token.
    await settings();
    expect(fake.requests.some((r) => r === "GET /v1/models Bearer sk-made-up-openai-key")).toBe(true);
  });
});

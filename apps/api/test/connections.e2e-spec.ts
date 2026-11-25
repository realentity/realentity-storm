import { KeyRing, open, openIntegration } from "@realentity/storm-crypto";
import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import {
  type GoogleClientView,
  type GoogleStatusView,
  type SettingsView,
  type TelegramConnectionSaved,
  type TelegramConnectionView,
  type TelegramTestView,
} from "@realentity/storm-shared";
import { createHash } from "node:crypto";
import { authenticator } from "otplib";
import request from "supertest";
import { AuthService } from "../src/auth/auth.service";
import { TELEGRAM_FETCH } from "../src/telegram/telegram-notices";
import { createTestApp, type TestApp } from "./support/test-app";

const TOKEN = `123456:${"t".repeat(35)}`;
const OTHER_TOKEN = `654321:${"u".repeat(35)}`;
const PASTED = "p".repeat(48);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// M63: the Storm bot, Google's OAuth client, the hooks address and the run limits: in Settings, not .env.
describe("connections in Settings", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;
  let calls: { method: string; token: string; body: Record<string, unknown> }[];
  let refuse: string | null;

  /** A fresh valid code: the test asks more often than a code changes, so the last one used is forgotten first. */
  const code = () => {
    const auth: unknown = api.app.get(AuthService);
    (auth as { lastAcceptedTotp: string | null }).lastAcceptedTotp = null;
    return authenticator.generate(api.totpSecret);
  };
  const keys = () => KeyRing.fromEnv(process.env);
  const hook = (secret?: string) =>
    request(api.http)
      .post("/api/hooks/telegram")
      .set(secret ? { "x-telegram-bot-api-secret-token": secret } : {})
      .send({ update_id: 1 });

  beforeAll(async () => {
    const fakeFetch: typeof fetch = (input, init) => {
      const url = input as string;
      const method = url.split("/").pop()!;
      calls.push({ method, token: url.split("/bot")[1]?.split("/")[0] ?? "", body: JSON.parse((init?.body as string) || "{}") as Record<string, unknown> });
      if (refuse === method) return Promise.resolve(new Response(JSON.stringify({ ok: false, description: "Bad Request: bad webhook" }), { status: 400 }));
      const result = method === "getMe" ? { username: "storm_test_bot" } : method === "sendMessage" ? { message_id: 7 } : true;
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result })));
    };
    api = await createTestApp({ overrides: [{ provide: TELEGRAM_FETCH, useValue: fakeFetch }] });
    agent = await api.signedIn();
    db = createPrismaConnection();
    await db.client.integration.deleteMany({ where: { kind: { in: ["TELEGRAM", "GOOGLE_OAUTH"] } } });
  });

  beforeEach(() => {
    calls = [];
    refuse = null;
  });

  afterAll(async () => {
    await db.client.integration.deleteMany({ where: { kind: { in: ["TELEGRAM", "GOOGLE_OAUTH"] } } });
    await db.client.userSetting.updateMany({ data: { hooksPublicUrl: null, artifactsRetentionDays: null, takeoverTimeoutMinutes: null, downloadMaxMb: null } });
    await db.close();
    await api.close();
  });

  describe("the Storm bot", () => {
    afterEach(async () => {
      await db.client.integration.deleteMany({ where: { kind: "TELEGRAM" } });
    });

    it("is set up only with the code; the token sealed and never returned; a generated secret shown once, kept as its hash", async () => {
      expect((await agent.get("/api/telegram/connection").expect(200)).body).toMatchObject({ configured: false, webhookSecretSet: false });
      await agent.put("/api/telegram/connection").send({ botToken: TOKEN, chatId: "4242" }).expect(401);
      await agent.put("/api/telegram/connection").send({ chatId: "4242", code: code() }).expect(400);
      await hook("anything").expect(404);

      const saved = (
        await agent
          .put("/api/telegram/connection")
          .send({ botToken: TOKEN, chatId: "4242", webhook: { secret: "generate" }, register: "https://hooks.test/storm/telegram", code: code() })
          .expect(200)
      ).body as TelegramConnectionSaved;
      expect(saved).toMatchObject({ configured: true, enabled: true, chatId: "4242", tokenHint: "…tttt", webhookSecretSet: true, registered: { ok: true, error: null } });
      expect(saved.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(saved)).not.toContain(TOKEN);
      expect(calls.find((c) => c.method === "setWebhook")).toMatchObject({
        token: TOKEN,
        body: { url: "https://hooks.test/storm/telegram", secret_token: saved.webhookSecret, allowed_updates: ["message", "callback_query"] },
      });

      const read = (await agent.get("/api/telegram/connection").expect(200)).body as TelegramConnectionView;
      expect(read).toMatchObject({ configured: true, webhookUrl: "https://hooks.test/storm/telegram" });
      expect(read).not.toHaveProperty("webhookSecret");
      expect(JSON.stringify(read)).not.toContain(TOKEN);

      const row = await db.client.integration.findFirstOrThrow({ where: { kind: "TELEGRAM" } });
      expect(openIntegration(keys(), row.integrationId, row as Parameters<typeof openIntegration>[2])).toBe(TOKEN);
      // Sealed for the connections only: not as a credential.
      expect(() => open(keys(), row.integrationId, row as Parameters<typeof open>[2])).toThrow();
      expect(row.secretHash).toBe(sha256(saved.webhookSecret!));
      expect(JSON.stringify(row.config)).not.toContain(saved.webhookSecret!);

      // /hooks/telegram takes the saved secret only.
      await hook(saved.webhookSecret).expect(200);
      await hook("wrong").expect(404);
      await hook().expect(404);
    });

    it("takes a pasted secret (a gateway's), says when Telegram refuses the webhook, and changes the chat with the code", async () => {
      await agent.put("/api/telegram/connection").send({ botToken: TOKEN, chatId: "4242", webhook: { secret: "paste", value: PASTED }, code: code() }).expect(200);
      await hook(PASTED).expect(200);
      expect(calls.some((c) => c.method === "setWebhook")).toBe(false);

      refuse = "setWebhook";
      const refused = (
        await agent
          .put("/api/telegram/connection")
          .send({ webhook: { secret: "paste", value: PASTED }, register: "https://hooks.test/storm/telegram", code: code() })
          .expect(200)
      ).body as TelegramConnectionSaved;
      expect(refused.registered).toEqual({ ok: false, error: expect.stringContaining("bad webhook") as unknown });
      expect(refused).not.toHaveProperty("webhookSecret");
      expect(refused.webhookUrl).toBeNull();

      await agent.put("/api/telegram/connection").send({ chatId: "5151" }).expect(401);
      await agent.put("/api/telegram/connection").send({ register: "https://hooks.test/x" }).expect(400);
      await agent.put("/api/telegram/connection").send({ webhook: { secret: "paste", value: "short" }, code: code() }).expect(400);
      expect((await agent.put("/api/telegram/connection").send({ chatId: "5151", code: code() }).expect(200)).body).toMatchObject({ chatId: "5151", tokenHint: "…tttt" });
      // A new token replaces the old one; the hint follows.
      expect((await agent.put("/api/telegram/connection").send({ botToken: OTHER_TOKEN, code: code() }).expect(200)).body).toMatchObject({ tokenHint: "…uuuu" });
    });

    it("tests the token and the chat; switched off it sends nothing and takes no update; removed, its token and secret go", async () => {
      await agent.put("/api/telegram/connection").send({ botToken: TOKEN, chatId: "4242", webhook: { secret: "paste", value: PASTED }, code: code() }).expect(200);
      const tested = (await agent.post("/api/telegram/connection/test").expect(200)).body as TelegramTestView;
      expect(tested).toEqual({ ok: true, bot: "@storm_test_bot", error: null });
      expect(calls.find((c) => c.method === "sendMessage")).toMatchObject({ token: TOKEN, body: { chat_id: "4242" } });

      refuse = "getMe";
      expect((await agent.post("/api/telegram/connection/test").expect(200)).body).toMatchObject({ ok: false, error: expect.stringContaining("refused") as unknown });

      // Off needs no code: it only stops.
      expect((await agent.put("/api/telegram/connection").send({ enabled: false }).expect(200)).body).toMatchObject({ enabled: false });
      await hook(PASTED).expect(404);
      expect((await agent.get("/api/telegram/commands").expect(200)).body).toMatchObject({ configured: false });
      await agent.put("/api/telegram/connection").send({ enabled: true }).expect(200);
      await hook(PASTED).expect(200);

      await agent.delete("/api/telegram/connection").expect(204);
      expect(await db.client.integration.count({ where: { kind: "TELEGRAM" } })).toBe(0);
      await hook(PASTED).expect(404);
    });

    it("isn't listed among the model servers", async () => {
      await agent.put("/api/telegram/connection").send({ botToken: TOKEN, chatId: "4242", code: code() }).expect(200);
      const row = await db.client.integration.findFirstOrThrow({ where: { kind: "TELEGRAM" } });
      expect(((await agent.get("/api/integrations").expect(200)).body as { kind: string }[]).some((i) => i.kind === "TELEGRAM")).toBe(false);
      await agent.patch(`/api/integrations/${row.integrationId}`).send({ enabled: false }).expect(404);
      await agent.delete(`/api/integrations/${row.integrationId}`).expect(404);
      expect(((await agent.get("/api/settings").expect(200)).body as SettingsView).servers.some((s) => s.integrationId === row.integrationId)).toBe(false);
    });
  });

  describe("Google's OAuth client", () => {
    const CLIENT_ID = "123-abc.apps.googleusercontent.com";

    it("is saved with the code, its secret sealed and only hinted; removed, Google isn't set up", async () => {
      expect((await agent.get("/api/google").expect(200)).body).toMatchObject({ configured: false });
      await agent.post("/api/google/connect").send({}).expect(400);
      await agent.put("/api/google/client").send({ clientId: CLIENT_ID, clientSecret: "GOCSPX-made-up-secret" }).expect(400);
      await agent.put("/api/google/client").send({ clientId: CLIENT_ID, code: code() }).expect(400);
      await agent.put("/api/google/client").send({ clientId: "not-a-client-id", clientSecret: "GOCSPX-made-up-secret", code: code() }).expect(400);

      const saved = (await agent.put("/api/google/client").send({ clientId: CLIENT_ID, clientSecret: "GOCSPX-made-up-secret", code: code() }).expect(200))
        .body as GoogleClientView;
      expect(saved).toEqual({ configured: true, clientId: CLIENT_ID, secretHint: "…cret" });
      expect(((await agent.get("/api/google").expect(200)).body as GoogleStatusView).configured).toBe(true);
      const row = await db.client.integration.findFirstOrThrow({ where: { kind: "GOOGLE_OAUTH" } });
      expect(openIntegration(keys(), row.integrationId, row as Parameters<typeof openIntegration>[2])).toBe("GOCSPX-made-up-secret");

      // The consent screen uses it.
      const { url } = (await agent.post("/api/google/connect").send({}).expect(201)).body as { url: string };
      expect(new URL(url).searchParams.get("client_id")).toBe(CLIENT_ID);

      // Another id, the secret kept.
      const other = "456-def.apps.googleusercontent.com";
      expect((await agent.put("/api/google/client").send({ clientId: other, code: code() }).expect(200)).body).toEqual({ configured: true, clientId: other, secretHint: "…cret" });

      await agent.delete("/api/google/client").expect(204);
      expect((await agent.get("/api/google").expect(200)).body).toMatchObject({ configured: false });
    });
  });

  describe("the hooks address and the run limits", () => {
    it("are settings: defaults until set, an https address without its trailing slash, back to the default with null", async () => {
      const initial = (await agent.get("/api/settings").expect(200)).body as SettingsView;
      expect(initial).toMatchObject({ hooksPublicUrl: null, artifactsRetentionDays: 90, takeoverTimeoutMinutes: 30, downloadMaxMb: 25 });

      const saved = (
        await agent
          .put("/api/settings")
          .send({ hooksPublicUrl: "https://hooks.example.com/hooks//", artifactsRetentionDays: 0, takeoverTimeoutMinutes: 5, downloadMaxMb: 100 })
          .expect(200)
      ).body as SettingsView;
      expect(saved).toMatchObject({ hooksPublicUrl: "https://hooks.example.com/hooks", artifactsRetentionDays: 0, takeoverTimeoutMinutes: 5, downloadMaxMb: 100 });

      await agent.put("/api/settings").send({ hooksPublicUrl: "http://hooks.example.com" }).expect(400);
      await agent.put("/api/settings").send({ takeoverTimeoutMinutes: 0 }).expect(400);
      await agent.put("/api/settings").send({ downloadMaxMb: 501 }).expect(400);

      const reset = (await agent.put("/api/settings").send({ hooksPublicUrl: null, artifactsRetentionDays: null, takeoverTimeoutMinutes: null, downloadMaxMb: null }).expect(200))
        .body as SettingsView;
      expect(reset).toMatchObject({ hooksPublicUrl: null, artifactsRetentionDays: 90, takeoverTimeoutMinutes: 30, downloadMaxMb: 25 });
    });

    it("the download limit applies to uploads from the next one on", async () => {
      await agent.put("/api/settings").send({ downloadMaxMb: 1 }).expect(200);
      const big = Buffer.alloc(1_048_576 + 10, 0x41);
      await agent.post("/api/documents").field("name", "cv-big").attach("file", big, { filename: "cv.pdf", contentType: "application/pdf" }).expect(413);
      await agent.put("/api/settings").send({ downloadMaxMb: null }).expect(200);
    });
  });
});

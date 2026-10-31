import { SESSION_COOKIE } from "@ai-me/shared";
import { authenticator } from "otplib";
import request from "supertest";
import { createTestApp, TEST_PASSWORD, type TestApp } from "./support/test-app";

describe("auth", () => {
  let api: TestApp;

  beforeEach(async () => {
    api = await createTestApp();
  });

  afterEach(async () => {
    await api.close();
  });

  const http = () => request(api.http);
  const login = (body: object) => http().post("/api/auth/login").send(body);

  it("serves health without a session", async () => {
    await http().get("/api/health").expect(200, { status: "ok" });
  });

  // M3-E7 (first part): everything else needs a session
  it.each([
    ["GET", "/api/auth/session"],
    ["POST", "/api/auth/logout"],
    ["GET", "/api/credentials"],
    ["POST", "/api/credentials"],
    ["PUT", "/api/credentials/4f6c2a1e-6c1b-4e0a-9a51-2f3c5d7e8a90/secret"],
    ["DELETE", "/api/credentials/4f6c2a1e-6c1b-4e0a-9a51-2f3c5d7e8a90"],
    ["POST", "/api/pipelines/compile"],
    ["GET", "/api/pipelines"],
    ["POST", "/api/pipelines"],
    ["GET", "/api/pipelines/4f6c2a1e-6c1b-4e0a-9a51-2f3c5d7e8a90"],
    ["POST", "/api/pipelines/4f6c2a1e-6c1b-4e0a-9a51-2f3c5d7e8a90/versions"],
    ["GET", "/api/pipelines/4f6c2a1e-6c1b-4e0a-9a51-2f3c5d7e8a90/versions/1"],
  ])("rejects %s %s without a session", async (method, path) => {
    await http()[method.toLowerCase() as "get" | "post" | "put" | "delete"](path).expect(401);
  });

  it("signs in with password + TOTP and sets a strict, httpOnly session cookie", async () => {
    const response = await login({ password: TEST_PASSWORD, totp: authenticator.generate(api.totpSecret) }).expect(200);
    const cookie = ([] as string[]).concat(response.headers["set-cookie"] ?? []).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(response.body).toMatchObject({ email: "me@aime.test" });
  });

  it("keeps the session until logout", async () => {
    const agent = await api.signedIn();
    await agent.get("/api/auth/session").expect(200);
    await agent.post("/api/auth/logout").expect(204);
    await agent.get("/api/auth/session").expect(401);
  });

  it("rejects a forged session cookie", async () => {
    await http().get("/api/auth/session").set("Cookie", `${SESSION_COOKIE}=forged`).expect(401);
  });

  // M1-S5
  it("rejects a wrong password", async () => {
    await login({ password: "wrong password", totp: authenticator.generate(api.totpSecret) }).expect(401);
  });

  it("rejects a wrong TOTP code", async () => {
    const code = authenticator.generate(api.totpSecret);
    const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
    await login({ password: TEST_PASSWORD, totp: wrong }).expect(401);
  });

  it("rejects a replayed TOTP code", async () => {
    const totp = authenticator.generate(api.totpSecret);
    await login({ password: TEST_PASSWORD, totp }).expect(200);
    await login({ password: TEST_PASSWORD, totp }).expect(401);
  });

  it("rate limits login attempts (brute force)", async () => {
    for (let i = 0; i < 5; i++) {
      await login({ password: "wrong", totp: "000000" }).expect(401);
    }
    await login({ password: TEST_PASSWORD, totp: authenticator.generate(api.totpSecret) }).expect(429);
  });

  it("validates the login body", async () => {
    await login({ password: TEST_PASSWORD, totp: "12" }).expect(400);
  });
});

describe("auth when not configured", () => {
  it("refuses login until pnpm auth:setup values are set", async () => {
    const api = await createTestApp({ configured: false });
    try {
      await request(api.http).post("/api/auth/login").send({ password: "anything", totp: "123456" }).expect(503);
    } finally {
      await api.close();
    }
  });
});

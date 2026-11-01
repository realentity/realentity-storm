import { KeyRing, open } from "@ai-me/crypto";
import { createPrismaConnection, type PrismaConnection } from "@ai-me/db";
import { GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, type GoogleStatusView } from "@ai-me/shared";
import { TestEnvironment } from "@ai-me/testing";
import { createHash } from "node:crypto";
import type TestAgent from "supertest/lib/agent";
import { GOOGLE_FETCH } from "../src/google/google.service";
import { createTestApp, type TestApp } from "./support/test-app";

const ENV = {
  GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "GOCSPX-secret-value",
  APP_ORIGIN: "https://aime.test",
};

const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.sig`;

// M14-T1: connecting Google Calendar (consent screen, the code for a refresh token, sealed) and what it continues.
describe("Google Calendar connection", () => {
  let api: TestApp;
  let agent: TestAgent;
  let db: PrismaConnection;
  let userId: string;
  const exchanges: URLSearchParams[] = [];
  let answer: { status: number; body: Record<string, unknown> };

  const fakeFetch = (input: string, init?: { body?: string }) => {
    if (input !== GOOGLE_TOKEN_URL) return Promise.reject(new Error(`unexpected ${input}`));
    exchanges.push(new URLSearchParams(init?.body));
    return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } }));
  };

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    api = await createTestApp({ overrides: [{ provide: GOOGLE_FETCH, useValue: fakeFetch }] });
    agent = await api.signedIn();
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(() => {
    exchanges.length = 0;
    answer = {
      status: 200,
      body: {
        access_token: "access-1",
        expires_in: 3599,
        refresh_token: "refresh-1",
        scope: "openid https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email",
        id_token: idToken("ana@gmail.test"),
      },
    };
  });

  afterEach(async () => {
    await db.client.googleConnection.deleteMany();
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
  });

  afterAll(async () => {
    for (const key of Object.keys(ENV)) delete process.env[key];
    await db.close();
    await api.close();
  });

  /** Connect pressed: the consent screen's address, and its state and PKCE challenge. */
  const startConnect = async (returnTo?: string) => {
    const { url } = (await agent.post("/api/google/connect").send(returnTo ? { returnTo } : {}).expect(201)).body as { url: string };
    return new URL(url);
  };
  const callback = (query: Record<string, string>) => agent.get(`/api/google/callback?${new URLSearchParams(query).toString()}`).expect(302);

  it("sends me to Google's consent screen for offline calendar access, and back to the redirect URI", async () => {
    const status = (await agent.get("/api/google").expect(200)).body as GoogleStatusView;
    expect(status).toEqual({
      configured: true,
      redirectUri: "https://aime.test/api/google/callback",
      connected: false,
      email: null,
      status: null,
      lastWorkedAt: null,
      brokenAt: null,
      brokenReason: null,
    });
    const url = await startConnect();
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTH_URL);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: ENV.GOOGLE_CLIENT_ID,
      redirect_uri: "https://aime.test/api/google/callback",
      response_type: "code",
      scope: "openid email https://www.googleapis.com/auth/calendar.events",
      access_type: "offline",
      prompt: "consent",
      code_challenge_method: "S256",
    });
    await agent.post("/api/google/connect").send({ returnTo: "https://evil.test/" }).expect(400);
  });

  it("the code becomes a sealed refresh token; waiting runs go on; I come back where I started", async () => {
    // A run waiting for the reconnect (what the worker's calendar step opens).
    const pipeline = await db.client.pipeline.create({ data: { userId, name: "Interview invites" } });
    const version = await db.client.pipelineVersion.create({ data: { pipelineId: pipeline.pipelineId, version: 1, definition: {}, policy: {} } });
    const run = await db.client.run.create({ data: { pipelineVersionId: version.pipelineVersionId, userId, status: "WAITING_FOR_USER", trigger: "manual" } });
    const wait = await db.client.takeover.create({ data: { runId: run.runId, status: "OPEN", reason: "Google Calendar needs reconnecting", waitsFor: "google" } });
    const browserWait = await db.client.takeover.create({ data: { runId: run.runId, status: "OPEN", reason: "CAPTCHA" } });

    const url = await startConnect(`/runs/${run.runId}`);
    const response = await callback({ code: "code-1", state: url.searchParams.get("state")! });
    expect(response.headers.location).toBe(`/runs/${run.runId}?google=connected#google`);

    // PKCE: the verifier sent matches the challenge on the consent screen.
    expect(exchanges).toHaveLength(1);
    const verifier = exchanges[0].get("code_verifier")!;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
    expect(Object.fromEntries(exchanges[0])).toMatchObject({ grant_type: "authorization_code", code: "code-1", redirect_uri: "https://aime.test/api/google/callback" });

    const row = await db.client.googleConnection.findUniqueOrThrow({ where: { userId } });
    expect(row).toMatchObject({ email: "ana@gmail.test", status: "CONNECTED", brokenAt: null });
    expect(Buffer.from(row.ciphertext).toString("utf8")).not.toContain("refresh-1");
    expect(open(KeyRing.fromEnv(process.env), userId, row)).toBe("refresh-1");

    expect(await db.client.takeover.findUniqueOrThrow({ where: { takeoverId: wait.takeoverId } })).toMatchObject({ status: "CONTINUED" });
    expect(await db.client.takeover.findUniqueOrThrow({ where: { takeoverId: browserWait.takeoverId } })).toMatchObject({ status: "OPEN" });

    expect((await agent.get("/api/google").expect(200)).body).toMatchObject({ connected: true, email: "ana@gmail.test", status: "CONNECTED" });
    await agent.delete("/api/google").expect(204);
    expect(await db.client.googleConnection.count()).toBe(0);
  });

  it("the review screen warns about calendar steps until Google Calendar is connected", async () => {
    const source = "name: Today\nsteps:\n  - id: today\n    type: calendar.find\n    with: { durationMinutes: 60 }\n";
    const compiled = (await agent.post("/api/pipelines/compile").send({ source }).expect(200)).body as { result: { ok: boolean; warnings: { message: string }[] } };
    expect(compiled.result.warnings).toEqual([
      { path: "steps[0]", message: "Google Calendar isn't connected: connect it in Settings, or the run waits for it there" },
    ]);
    const url = await startConnect();
    await callback({ code: "code-1", state: url.searchParams.get("state")! });
    const after = (await agent.post("/api/pipelines/compile").send({ source }).expect(200)).body as { result: { warnings: unknown[] } };
    expect(after.result.warnings).toEqual([]);
  });

  it("lists a pipeline's scheduled starts and cancels a pending one (M14-T3)", async () => {
    const pipeline = await db.client.pipeline.create({ data: { userId, name: "Follow-up reminder" } });
    const at = new Date(Date.now() + 86_400_000);
    const pending = await db.client.scheduledStart.create({ data: { userId, pipelineId: pipeline.pipelineId, key: "follow-up:1", data: { job: "x" }, fireAt: at } });
    const list = (await agent.get(`/api/scheduled-starts?pipelineId=${pipeline.pipelineId}`).expect(200)).body as { status: string; pipeline: string }[];
    expect(list).toEqual([expect.objectContaining({ scheduledStartId: pending.scheduledStartId, pipeline: "Follow-up reminder", status: "PENDING", key: "follow-up:1" })]);
    await agent.delete(`/api/scheduled-starts/${pending.scheduledStartId}`).expect(204);
    expect(await db.client.scheduledStart.findUniqueOrThrow({ where: { scheduledStartId: pending.scheduledStartId } })).toMatchObject({
      status: "CANCELLED",
      reason: "cancelled by me",
    });
    // Only once, and only a pending one.
    await agent.delete(`/api/scheduled-starts/${pending.scheduledStartId}`).expect(404);
  });

  it("refuses a state it didn't start, a sign-in without calendar access, and one without a refresh token", async () => {
    expect((await callback({ code: "code-1", state: "made-up" })).headers.location).toMatch(/^\/settings\?google=the%20sign-in%20expired/);
    expect(exchanges).toHaveLength(0);

    // A state is used once.
    const used = await startConnect();
    await callback({ code: "code-1", state: used.searchParams.get("state")! });
    expect((await callback({ code: "code-1", state: used.searchParams.get("state")! })).headers.location).toMatch(/sign-in%20expired/);

    await db.client.googleConnection.deleteMany();
    answer.body.scope = "openid email";
    const noCalendar = await startConnect();
    expect((await callback({ code: "c", state: noCalendar.searchParams.get("state")! })).headers.location).toMatch(/calendar%20wasn't%20allowed/);

    answer.body.scope = "https://www.googleapis.com/auth/calendar.events";
    delete answer.body.refresh_token;
    const noRefresh = await startConnect();
    expect((await callback({ code: "c", state: noRefresh.searchParams.get("state")! })).headers.location).toMatch(/no%20refresh%20token/);

    const denied = await startConnect();
    expect((await callback({ error: "access_denied", state: denied.searchParams.get("state")! })).headers.location).toMatch(/you%20didn't%20allow%20access/);
    expect(await db.client.googleConnection.count()).toBe(0);
  });
});

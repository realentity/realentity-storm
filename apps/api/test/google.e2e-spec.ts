import { KeyRing, open } from "@realentity/storm-crypto";
import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL, type BindingView, type GoogleStatusView } from "@realentity/storm-shared";
import { TestEnvironment } from "@realentity/storm-testing";
import { createHash } from "node:crypto";
import request from "supertest";
import type TestAgent from "supertest/lib/agent";
import { GOOGLE_FETCH } from "../src/google/google.service";
import { createTestApp, withGoogleClient, type TestApp } from "./support/test-app";

const ENV = { APP_ORIGIN: "https://storm.test" };
/** M63: Google's OAuth client as Settings → Google saves it (made-up values). */
const CLIENT = { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-secret-value" };

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
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } }),
    );
  };

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    api = await createTestApp({ overrides: [{ provide: GOOGLE_FETCH, useValue: fakeFetch }] });
    agent = await api.signedIn();
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    await withGoogleClient(api, CLIENT);
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
    await db.client.googleAccount.deleteMany();
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
  });

  afterAll(async () => {
    for (const key of Object.keys(ENV)) delete process.env[key];
    await withGoogleClient(api, null);
    await db.close();
    await api.close();
  });

  /** Connect pressed: the consent screen's address, and its state and PKCE challenge. */
  const startConnect = async (returnTo?: string) => {
    const { url } = (
      await agent
        .post("/api/google/connect")
        .send(returnTo ? { returnTo } : {})
        .expect(201)
    ).body as { url: string };
    return new URL(url);
  };
  /** Google's redirect back: from accounts.google.com, so the browser sends no SameSite=Strict session cookie. */
  const callback = (query: Record<string, string>) =>
    request(api.http)
      .get(`/api/google/callback?${new URLSearchParams(query).toString()}`)
      .expect(302);

  it("sends the user to Google's consent screen for offline calendar and read-only Drive access, and back to the redirect URI", async () => {
    const status = (await agent.get("/api/google").expect(200)).body as GoogleStatusView;
    expect(status).toEqual({ configured: true, redirectUri: "https://storm.test/api/google/callback", accounts: [] });
    const url = await startConnect();
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTH_URL);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: CLIENT.clientId,
      redirect_uri: "https://storm.test/api/google/callback",
      response_type: "code",
      scope: "openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.readonly",
      access_type: "offline",
      // M50-T8: choosing the account first, so another one can be added.
      prompt: "select_account consent",
      code_challenge_method: "S256",
    });
    expect(url.searchParams.has("login_hint")).toBe(false);
    await agent.post("/api/google/connect").send({ returnTo: "https://evil.test/" }).expect(400);
  });

  it("the code becomes a sealed refresh token; waiting runs go on; the user comes back where they started", async () => {
    // A run waiting for the reconnect (what the worker's calendar step opens).
    const pipeline = await db.client.pipeline.create({ data: { userId, name: "Interview invites" } });
    const version = await db.client.pipelineVersion.create({
      data: { pipelineId: pipeline.pipelineId, version: 1, definition: {}, policy: {} },
    });
    const run = await db.client.run.create({
      data: { pipelineVersionId: version.pipelineVersionId, userId, status: "WAITING_FOR_USER", trigger: "manual" },
    });
    const wait = await db.client.takeover.create({
      data: { runId: run.runId, status: "OPEN", reason: "Google Calendar needs reconnecting", waitsFor: "google" },
    });
    const browserWait = await db.client.takeover.create({ data: { runId: run.runId, status: "OPEN", reason: "CAPTCHA" } });

    const url = await startConnect(`/runs/${run.runId}`);
    const response = await callback({ code: "code-1", state: url.searchParams.get("state")! });
    expect(response.headers.location).toBe(`/runs/${run.runId}?google=connected#google`);

    // PKCE: the verifier sent matches the challenge on the consent screen.
    expect(exchanges).toHaveLength(1);
    const verifier = exchanges[0].get("code_verifier")!;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
    expect(Object.fromEntries(exchanges[0])).toMatchObject({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "https://storm.test/api/google/callback",
    });

    const row = await db.client.googleAccount.findFirstOrThrow({ where: { userId } });
    expect(row).toMatchObject({ email: "ana@gmail.test", status: "CONNECTED", brokenAt: null, isDefault: true });
    expect(Buffer.from(row.ciphertext).toString("utf8")).not.toContain("refresh-1");
    // M50-T8: sealed to the account's id.
    expect(open(KeyRing.fromEnv(process.env), row.googleAccountId, row)).toBe("refresh-1");

    expect(await db.client.takeover.findUniqueOrThrow({ where: { takeoverId: wait.takeoverId } })).toMatchObject({ status: "CONTINUED" });
    expect(await db.client.takeover.findUniqueOrThrow({ where: { takeoverId: browserWait.takeoverId } })).toMatchObject({ status: "OPEN" });

    // Drive unticked at Google: the calendar works, Drive says it isn't allowed.
    expect(((await agent.get("/api/google").expect(200)).body as GoogleStatusView).accounts).toEqual([
      expect.objectContaining({ email: "ana@gmail.test", status: "CONNECTED", isDefault: true, calendar: true, drive: false, usedBy: [] }),
    ]);
    await agent.delete(`/api/google/accounts/${row.googleAccountId}`).expect(204);
    expect(await db.client.googleAccount.count()).toBe(0);
  });

  // M50-T8: several Google accounts
  it("another account is added, the same one reconnected; one is the default; a google slot is filled with one that allows what it uses", async () => {
    const signIn = async (email: string, scope: string, account?: string) => {
      answer.body = { ...answer.body, id_token: idToken(email), scope, refresh_token: `refresh-${email}` };
      const { url } = (
        await agent
          .post("/api/google/connect")
          .send(account ? { account } : {})
          .expect(201)
      ).body as { url: string };
      const started = new URL(url);
      await callback({ code: "c", state: started.searchParams.get("state")! });
      return started;
    };
    const both = "openid https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.readonly";
    await signIn("Ana@Gmail.test", both);
    await signIn("ana@work.test", "openid https://www.googleapis.com/auth/drive.readonly");
    const accounts = () => (agent.get("/api/google").expect(200) as Promise<{ body: GoogleStatusView }>).then((r) => r.body.accounts);
    expect((await accounts()).map((a) => [a.email, a.isDefault, a.calendar])).toEqual([
      ["ana@gmail.test", true, true],
      ["ana@work.test", false, false],
    ]);
    const [home, work] = await accounts();

    // Reconnecting one: signed in as it (login_hint), the same row with a new token.
    const again = await signIn("ana@work.test", both, work.googleAccountId);
    expect(again.searchParams.get("login_hint")).toBe("ana@work.test");
    expect(again.searchParams.get("prompt")).toBe("consent");
    expect(await db.client.googleAccount.count()).toBe(2);
    const row = await db.client.googleAccount.findUniqueOrThrow({ where: { googleAccountId: work.googleAccountId } });
    expect(open(KeyRing.fromEnv(process.env), row.googleAccountId, row)).toBe("refresh-ana@work.test");

    await agent.put(`/api/google/accounts/${work.googleAccountId}/default`).expect(204);
    expect((await accounts()).map((a) => [a.email, a.isDefault])).toEqual([
      ["ana@work.test", true],
      ["ana@gmail.test", false],
    ]);

    // A pipeline's google slot (a calendar step's account): offered the accounts allowing the calendar, chosen by id.
    const source = "name: Work calendar\nsteps:\n  - id: today\n    type: calendar.find\n    with: { account: work }\n";
    const pipeline = (await agent.post("/api/pipelines").send({ source }).expect(201)).body as { pipelineId: string };
    const bindings = `/api/pipelines/${pipeline.pipelineId}/bindings`;
    const [slot] = (await agent.get(bindings).expect(200)).body as BindingView[];
    expect(slot).toMatchObject({ slot: "work", need: { kind: "google", uses: ["calendar"] }, account: null });
    expect(slot.fits.map((f) => f.name)).toEqual(["ana@work.test", "ana@gmail.test"]);
    const [filled] = (
      await agent
        .put(bindings)
        .send({ work: { googleAccountId: home.googleAccountId } })
        .expect(200)
    ).body as BindingView[];
    expect(filled.account).toEqual({ id: home.googleAccountId, name: "ana@gmail.test" });
    expect((await accounts()).find((a) => a.email === "ana@gmail.test")?.usedBy).toEqual([
      { owner: "pipeline", id: pipeline.pipelineId, name: "Work calendar", slot: "work" },
    ]);
    await agent
      .put(bindings)
      .send({ work: { emailAccountId: home.googleAccountId } })
      .expect(400);

    // Removing the default: the other becomes it, and the slot filled with it is cleared (the default again).
    await agent.delete(`/api/google/accounts/${work.googleAccountId}`).expect(204);
    await agent.delete(`/api/google/accounts/${home.googleAccountId}`).expect(204);
    expect(((await agent.get(bindings).expect(200)).body as BindingView[])[0].account).toBeNull();
    await agent.post("/api/google/connect").send({ account: home.googleAccountId }).expect(404);
  });

  it("the review screen warns about calendar steps until Google Calendar is connected", async () => {
    const source = "name: Today\nsteps:\n  - id: today\n    type: calendar.find\n    with: { durationMinutes: 60 }\n";
    const compiled = (await agent.post("/api/pipelines/compile").send({ source }).expect(200)).body as {
      result: { ok: boolean; warnings: { message: string }[] };
    };
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
    const pending = await db.client.scheduledStart.create({
      data: { userId, pipelineId: pipeline.pipelineId, key: "follow-up:1", data: { job: "x" }, fireAt: at },
    });
    const list = (await agent.get(`/api/scheduled-starts?pipelineId=${pipeline.pipelineId}`).expect(200)).body as {
      status: string;
      pipeline: string;
    }[];
    expect(list).toEqual([
      expect.objectContaining({
        scheduledStartId: pending.scheduledStartId,
        pipeline: "Follow-up reminder",
        status: "PENDING",
        key: "follow-up:1",
      }),
    ]);
    await agent.delete(`/api/scheduled-starts/${pending.scheduledStartId}`).expect(204);
    expect(await db.client.scheduledStart.findUniqueOrThrow({ where: { scheduledStartId: pending.scheduledStartId } })).toMatchObject({
      status: "CANCELLED",
      reason: "cancelled by the user",
    });
    // Only once, and only a pending one.
    await agent.delete(`/api/scheduled-starts/${pending.scheduledStartId}`).expect(404);
  });

  it("refuses a state it didn't start, a sign-in allowing neither the calendar nor Drive, and one without a refresh token", async () => {
    expect((await callback({ code: "code-1", state: "made-up" })).headers.location).toMatch(/^\/settings\/google\?google=the%20sign-in%20expired/);
    expect(exchanges).toHaveLength(0);

    // A state is used once.
    const used = await startConnect();
    await callback({ code: "code-1", state: used.searchParams.get("state")! });
    expect((await callback({ code: "code-1", state: used.searchParams.get("state")! })).headers.location).toMatch(/sign-in%20expired/);

    await db.client.googleAccount.deleteMany();
    answer.body.scope = "openid email";
    const noCalendar = await startConnect();
    expect((await callback({ code: "c", state: noCalendar.searchParams.get("state")! })).headers.location).toMatch(
      /neither%20the%20calendar%20nor%20Drive%20was%20allowed/,
    );

    // Drive alone is enough.
    answer.body.scope = "openid email https://www.googleapis.com/auth/drive.readonly";
    const driveOnly = await startConnect();
    expect((await callback({ code: "c", state: driveOnly.searchParams.get("state")! })).headers.location).toBe(
      "/settings/google?google=connected#google",
    );
    expect(((await agent.get("/api/google").expect(200)).body as GoogleStatusView).accounts).toEqual([
      expect.objectContaining({ calendar: false, drive: true }),
    ]);
    await db.client.googleAccount.deleteMany();

    answer.body.scope = "https://www.googleapis.com/auth/calendar.events";
    delete answer.body.refresh_token;
    const noRefresh = await startConnect();
    expect((await callback({ code: "c", state: noRefresh.searchParams.get("state")! })).headers.location).toMatch(/no%20refresh%20token/);

    const denied = await startConnect();
    expect((await callback({ error: "access_denied", state: denied.searchParams.get("state")! })).headers.location).toMatch(
      /you%20didn't%20allow%20access/,
    );
    expect(await db.client.googleAccount.count()).toBe(0);
  });
});

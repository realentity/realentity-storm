import { createPrismaConnection, type PrismaConnection } from "@ai-me/db";
import { publishEvent } from "@ai-me/queue";
import { EVENTS_PATH, type AppEvent } from "@ai-me/shared";
import { TestEnvironment } from "@ai-me/testing";
import { type Server } from "node:http";
import { type AddressInfo } from "node:net";
import request from "supertest";
import { WebSocket } from "ws";
import { SessionService } from "../src/auth/session.service";
import { EventsService } from "../src/events/events.service";
import { createTestApp, type TestApp } from "./support/test-app";

// M3-T2
describe("live events (WebSocket)", () => {
  let api: TestApp;
  let db: PrismaConnection;
  let userId: string;
  let origin: string;
  let url: string;
  const open: WebSocket[] = [];

  beforeAll(async () => {
    api = await createTestApp();
    await api.app.listen(0, "127.0.0.1");
    const { port } = (api.app.getHttpServer() as Server).address() as AddressInfo;
    origin = `http://127.0.0.1:${port}`;
    url = `ws://127.0.0.1:${port}${EVENTS_PATH}`;
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  afterEach(async () => {
    for (const socket of open.splice(0)) socket.terminate();
    await db.client.userSetting.deleteMany();
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  /** A fresh session's cookie header (login itself is covered in auth.e2e-spec; TOTP codes can't be reused). */
  async function sessionCookie(): Promise<string> {
    const { token } = await api.app.get(SessionService).create(userId, {});
    return `aime_session=${token}`;
  }

  /** Opens a socket; resolves with it and the events it receives, or rejects with the refused status. */
  function connect(headers: Record<string, string>): Promise<{ socket: WebSocket; events: AppEvent[] }> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers });
      open.push(socket);
      const events: AppEvent[] = [];
      socket.on("message", (data: Buffer) => events.push(JSON.parse(data.toString()) as AppEvent));
      socket.on("open", () => resolve({ socket, events }));
      socket.on("unexpected-response", (_request, response) => reject(new Error(`refused ${response.statusCode}`)));
      socket.on("error", reject);
    });
  }

  async function eventually(check: () => void): Promise<void> {
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        check();
        return;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  it("refuses a socket without a session, with an unknown session, or from another origin", async () => {
    await expect(connect({ origin })).rejects.toThrow("refused 401");
    await expect(connect({ origin, cookie: "aime_session=forged" })).rejects.toThrow("refused 401");
    const cookie = await sessionCookie();
    await expect(connect({ origin: "https://evil.example", cookie })).rejects.toThrow("refused 401");
    await expect(connect({ cookie })).rejects.toThrow("refused 401");
  });

  it("forwards the worker's events (pg_notify) to my sockets only, and the api's own (kill switch)", async () => {
    const cookie = await sessionCookie();
    const { events } = await connect({ origin, cookie });
    const runEvent: AppEvent = { type: "run", runId: "r-1", pipelineId: "p-1", status: "RUNNING" };

    // As the worker does it: another process, the same channel.
    const execute = (sql: TemplateStringsArray, ...values: unknown[]) => db.client.$executeRaw(sql, ...values);
    await publishEvent(execute, "00000000-0000-4000-8000-000000000000", { type: "killSwitch", engaged: true });
    await publishEvent(execute, userId, runEvent);
    await eventually(() => expect(events).toEqual([runEvent]));

    await request(api.http).put("/api/kill-switch").set("Cookie", cookie).send({ engaged: true }).expect(200);
    await eventually(() => expect(events).toEqual([runEvent, { type: "killSwitch", engaged: true }]));
  });

  it("closes the socket once its session ends", async () => {
    const cookie = await sessionCookie();
    const { socket } = await connect({ origin, cookie });
    expect(api.app.get(EventsService).connections).toBe(1);

    await request(api.http).post("/api/auth/logout").set("Cookie", cookie).expect(204);
    const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));
    await api.app.get(EventsService).recheckSessions();
    await expect(closed).resolves.toBe(4401);
  });
});

// Behind tailscale serve the Host header may not be what the browser used: APP_ORIGIN pins the allowed Origin.
describe("live events behind a proxy (APP_ORIGIN)", () => {
  let api: TestApp;
  let url: string;
  let cookie: string;
  const open: WebSocket[] = [];

  beforeAll(async () => {
    process.env.APP_ORIGIN = "https://storm.example.ts.net:8100/";
    api = await createTestApp();
    delete process.env.APP_ORIGIN;
    await api.app.listen(0, "127.0.0.1");
    const { port } = (api.app.getHttpServer() as Server).address() as AddressInfo;
    url = `ws://127.0.0.1:${port}${EVENTS_PATH}`;
    const db = createPrismaConnection();
    const userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    await db.close();
    cookie = `aime_session=${(await api.app.get(SessionService).create(userId, {})).token}`;
  });

  afterAll(async () => {
    for (const socket of open) socket.terminate();
    await api.close();
  });

  const status = (origin: string) =>
    new Promise<number>((resolve) => {
      const socket = new WebSocket(url, { headers: { origin, cookie } });
      open.push(socket);
      socket.on("open", () => resolve(101));
      socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      socket.on("error", () => resolve(0));
    });

  it("accepts exactly APP_ORIGIN, and refuses the plain same-host origin", async () => {
    await expect(status("https://storm.example.ts.net:8100")).resolves.toBe(101);
    await expect(status(url.replace("ws:", "http:").replace(EVENTS_PATH, ""))).resolves.toBe(401);
    await expect(status("https://storm.example.ts.net:8030")).resolves.toBe(401);
    await expect(status("http://storm.example.ts.net:8100")).resolves.toBe(401);
  });
});

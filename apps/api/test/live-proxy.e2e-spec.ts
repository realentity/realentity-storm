import { createPrismaConnection } from "@realentity/storm-db";
import { TestEnvironment } from "@realentity/storm-testing";
import { readFile } from "node:fs/promises";
import { type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { join } from "node:path";
import { GenericContainer, TestContainers, Wait, type StartedTestContainer } from "testcontainers";
import { WebSocket, WebSocketServer } from "ws";
import { SessionService } from "../src/auth/session.service";
import { createTestApp, type TestApp } from "./support/test-app";

/** The image docker/Dockerfile builds the web stage from. */
const CADDY_IMAGE = "caddy:2.10-alpine";
const HOST = "host.testcontainers.internal";

// M8-T3 through the real front door: docker/Caddyfile's /vnc (forward_auth to the api), as deployed.
describe("live view through Caddy", () => {
  let api: TestApp;
  let vnc: WebSocketServer;
  let caddy: StartedTestContainer;
  let url: string;
  let cookie: string;

  beforeAll(async () => {
    api = await createTestApp();
    await api.app.listen(0, "0.0.0.0");
    const apiPort = ((api.app.getHttpServer() as Server).address() as AddressInfo).port;
    // Stands in for websockify: greets like a VNC server would.
    vnc = new WebSocketServer({ host: "0.0.0.0", port: 0 });
    vnc.on("connection", (socket) => socket.send("RFB 003.008\n"));
    await new Promise((resolve) => vnc.once("listening", resolve));
    const vncPort = (vnc.address() as AddressInfo).port;

    await TestContainers.exposeHostPorts(apiPort, vncPort);
    const caddyfile = (await readFile(join(__dirname, "../../../docker/Caddyfile"), "utf8"))
      .replaceAll("api:3000", `${HOST}:${apiPort}`)
      .replaceAll("worker:6080", `${HOST}:${vncPort}`);
    caddy = await new GenericContainer(CADDY_IMAGE)
      .withCopyContentToContainer([{ content: caddyfile, target: "/etc/caddy/Caddyfile" }])
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    url = `ws://${caddy.getHost()}:${caddy.getMappedPort(8080)}/vnc/`;

    const db = createPrismaConnection();
    const { userId } = await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } });
    await db.close();
    cookie = `storm_session=${(await api.app.get(SessionService).create(userId, {})).token}`;
  });

  afterAll(async () => {
    await caddy?.stop();
    vnc?.close();
    await api?.close();
  });

  /** Resolves with the first message, or rejects with the refused status (or a timeout: a check that never answers). */
  function firstMessage(headers: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers });
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error("timeout"));
      }, 10_000);
      const done = (settle: () => void) => {
        clearTimeout(timer);
        socket.terminate();
        settle();
      };
      socket.on("message", (data: Buffer) => done(() => resolve(data.toString())));
      socket.on("unexpected-response", (_request, response) => done(() => reject(new Error(`refused ${response.statusCode}`))));
      socket.on("error", (error) => done(() => reject(error)));
    });
  }

  it("passes a signed-in WebSocket on to websockify and refuses one without a session", async () => {
    // The session check must answer an upgrade request too (it once hung: Node gave it to the api's upgrade listener).
    expect(await firstMessage({ origin: "https://storm.example", cookie })).toBe("RFB 003.008\n");
    await expect(firstMessage({ origin: "https://storm.example" })).rejects.toThrow("refused 401");
    await expect(firstMessage({ cookie: "storm_session=forged" })).rejects.toThrow("refused 401");
  });
});

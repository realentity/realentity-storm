import { readFile } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { join } from "node:path";
import { GenericContainer, TestContainers, Wait, type StartedTestContainer } from "testcontainers";
import { createTestApp, type TestApp } from "./support/test-app";

/** The image docker/Dockerfile builds the web stage from. */
const CADDY_IMAGE = "caddy:2.10-alpine";
const HOST = "host.testcontainers.internal";
const SECRET = "h".repeat(40);

// M12-S4 through the real hooks-only site: docker/Caddyfile's :8081, which the VPS's hooks-gateway reaches.
describe("the hooks-only site", () => {
  let api: TestApp;
  let caddy: StartedTestContainer;
  let port: number;
  let host: string;

  beforeAll(async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    process.env.TELEGRAM_BOT_TOKEN = `123456:${"b".repeat(35)}`;
    process.env.TELEGRAM_CHAT_ID = "4242";
    api = await createTestApp();
    await api.app.listen(0, "0.0.0.0");
    const apiPort = ((api.app.getHttpServer() as Server).address() as AddressInfo).port;
    await TestContainers.exposeHostPorts(apiPort);
    const caddyfile = (await readFile(join(__dirname, "../../../docker/Caddyfile"), "utf8"))
      .replaceAll("api:3000", `${HOST}:${apiPort}`)
      .replaceAll("worker:6080", `${HOST}:${apiPort}`);
    caddy = await new GenericContainer(CADDY_IMAGE)
      .withCopyContentToContainer([{ content: caddyfile, target: "/etc/caddy/Caddyfile" }])
      .withExposedPorts(8081)
      .withWaitStrategy(Wait.forListeningPorts())
      .start();
    host = caddy.getHost();
    port = caddy.getMappedPort(8081);
  });

  afterAll(async () => {
    for (const key of ["TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) delete process.env[key];
    await caddy?.stop();
    await api?.close();
  });

  /** A raw request: the path goes out exactly as written (no client-side ../ cleaning). */
  function send(method: string, path: string, body = "", headers: Record<string, string> = {}): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host, port, method, path, headers: { "content-type": "application/json", ...headers } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end(body);
    });
  }

  it("passes POST /hooks/telegram with its secret on to the api", async () => {
    expect(await send("POST", "/hooks/telegram", "{}", { "x-telegram-bot-api-secret-token": SECRET })).toBe(200);
    expect(await send("POST", "/hooks/telegram", "{}", { "x-telegram-bot-api-secret-token": "nope" })).toBe(404);
  });

  it("serves nothing else: not the app, not the api, not other methods, not a path that climbs out", async () => {
    const attempts: [string, string][] = [
      ["GET", "/"],
      ["GET", "/index.html"],
      ["GET", "/api/health"],
      ["POST", "/api/auth/login"],
      ["GET", "/api/proposals"],
      ["GET", "/hooks/telegram"],
      ["POST", "/hooks/telegram/extra"],
      ["POST", "/hooks/../api/auth/login"],
      ["POST", "/hooks/%2e%2e/auth/login"],
      ["POST", "/hooks/..%2fauth%2flogin"],
      ["GET", "/vnc/"],
    ];
    for (const [method, path] of attempts) {
      expect([method, path, await send(method, path, method === "POST" ? "{}" : "", { "x-telegram-bot-api-secret-token": SECRET })]).toEqual([
        method,
        path,
        404,
      ]);
    }
  });

  it("refuses a body over the limit (Caddy 128 KB, the api 64 KB)", async () => {
    expect(await send("POST", "/hooks/telegram", JSON.stringify({ text: "x".repeat(200 * 1024) }), { "x-telegram-bot-api-secret-token": SECRET })).toBe(413);
  });
});

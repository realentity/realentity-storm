import { createPrismaConnection, type Prisma, type PrismaConnection } from "@realentity/storm-db";
import { readAppSource } from "@realentity/storm-shared";
import { defaultCatalog, PipelineCompiler } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { type AddressInfo, BlockList, createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { join } from "node:path";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry, NO_ATTENTION, type StepContext } from "../src/runner/step-executor";
import { HttpCheckStep, NetCheckStep, type CheckOptions } from "../src/steps/check-steps";
import { FilterStep, SaveStep } from "../src/steps/data-steps";
import { ReadStep } from "../src/steps/entity-steps";
import { HistoryStep } from "../src/steps/history-step";
import { MapStep } from "../src/steps/map-alert-steps";
import { Counting, createVersion } from "./support/test-steps";

jest.setTimeout(60_000);

const SERVER_OPS = readFileSync(join(__dirname, "../../../pipelines/apps/server-ops.yaml"), "utf8");
const CHECK_MONITORS = readFileSync(join(__dirname, "../../../pipelines/check-monitors.yaml"), "utf8");

/**
 * The test's addresses: its servers listen on 127.0.0.1, which here plays a LAN address (private: only from a field of
 * mine); link-local and metadata stay never. nas.home.example resolves to it.
 */
function testOptions(): CheckOptions {
  const never = new BlockList();
  never.addSubnet("169.254.0.0", 16, "ipv4");
  never.addSubnet("0.0.0.0", 8, "ipv4");
  const lan = new BlockList();
  lan.addSubnet("127.0.0.0", 8, "ipv4");
  lan.addSubnet("192.168.0.0", 16, "ipv4");
  const resolve = (host: string) =>
    host === "nas.home.example" ? Promise.resolve([{ address: "127.0.0.1", family: 4 }]) : Promise.reject(new Error(`ENOTFOUND ${host}`));
  return { never, private: lan, resolve, ping: () => Promise.resolve(3) };
}

// M47-I1, S1 (the worker's half): your Monitors checked; one down opens an Incident, up again resolves it
describe("checks and monitors", () => {
  let db: PrismaConnection;
  let userId: string;
  let appId: string;
  let web: Server;
  let webPort: number;
  let healthy = true;
  let tcp: TcpServer;
  let tcpPort: number;
  let closedPort: number;
  let telegram: Counting;
  let runner: PipelineRunner;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    web = createServer((req, res) => {
      if (req.url === "/moved") return res.writeHead(302, { location: "/health" }).end();
      res.writeHead(healthy ? 200 : 503).end("a page that is never read");
    });
    await new Promise<void>((done) => web.listen(0, "127.0.0.1", done));
    webPort = (web.address() as AddressInfo).port;
    tcp = createTcpServer((socket) => socket.end());
    await new Promise<void>((done) => tcp.listen(0, "127.0.0.1", done));
    tcpPort = (tcp.address() as AddressInfo).port;
    // A port nothing listens on: one opened and closed.
    const probe = createTcpServer();
    await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
    closedPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((done) => probe.close(() => done()));
  });

  beforeEach(async () => {
    healthy = true;
    const app = await db.client.app.create({ data: { userId, name: "Server ops" } });
    const version = await db.client.appVersion.create({ data: { appId: app.appId, version: 1, definition: {}, source: SERVER_OPS } });
    await db.client.app.update({ where: { appId: app.appId }, data: { currentVersionId: version.appVersionId } });
    appId = app.appId;
    telegram = new Counting("notify.telegram", () => ({ sent: true }));
    const options = testOptions();
    runner = new PipelineRunner(
      db.client,
      defaultCatalog(),
      new ExecutorRegistry([
        new ReadStep(db.client),
        new SaveStep(db.client),
        new MapStep(),
        new HistoryStep(db.client),
        new FilterStep(),
        new HttpCheckStep(options),
        new NetCheckStep(options),
        telegram,
      ]),
    );
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.app.deleteMany();
    await db.client.dataPoint.deleteMany();
  });

  afterAll(async () => {
    await new Promise<void>((done) => web.close(() => done()));
    await new Promise<void>((done) => tcp.close(() => done()));
    await db.close();
  });

  /** A monitor as its page adds one: the name, the rest yours (mine). */
  const monitor = (name: string, mine: Record<string, unknown>) =>
    db.client.dataEntity.create({ data: { appId, type: "Monitor", key: name, value: { name }, mine: mine as Prisma.InputJsonObject } });
  const entity = async (type: string, key: string) => {
    const row = await db.client.dataEntity.findUniqueOrThrow({ where: { appId_type_key: { appId, type, key } } });
    return { ...(row.value as Record<string, unknown>), stage: row.stage };
  };

  it("pipelines/check-monitors.yaml: status, response times and certificates kept; an incident opened and resolved, told once each", async () => {
    await monitor("nas", { kind: "http", url: `http://nas.home.example:${webPort}/moved` });
    await monitor("db", { kind: "tcp", host: "nas.home.example", port: closedPort });
    await monitor("router", { kind: "ping", host: "192.168.1.1" });
    await monitor("metadata", { kind: "http", url: "http://169.254.169.254/latest/meta-data/" });
    await monitor("old", { kind: "http", url: `http://nas.home.example:${webPort}/`, paused: true });
    const versionId = await createVersion(db.client, userId, CHECK_MONITORS, new PipelineCompiler(defaultCatalog()), { app: readAppSource(SERVER_OPS) });
    const run = async () => {
      const runId = await runner.start(versionId, { trigger: "manual" });
      expect(await runner.advance(runId)).toBe("DONE");
      return runId;
    };

    await run();
    expect(await entity("Monitor", "nas")).toMatchObject({ status: "up", ms: expect.any(Number) as unknown });
    expect(await entity("Monitor", "nas")).not.toHaveProperty("error");
    expect(await entity("Monitor", "db")).toMatchObject({ status: "down", error: `port ${closedPort} refused the connection` });
    expect(await entity("Monitor", "router")).toMatchObject({ status: "up", ms: 3 });
    // A metadata address is never checked, even typed by you.
    expect(await entity("Monitor", "metadata")).toMatchObject({ status: "down", error: expect.stringContaining("never checked") as unknown });
    expect(await entity("Monitor", "old")).toEqual({ name: "old", stage: null });
    const incidents = await db.client.dataEntity.findMany({ where: { appId, type: "Incident" }, orderBy: { key: "asc" } });
    expect(incidents.map((i) => [(i.value as { subject: string }).subject, i.stage])).toEqual([
      ["db", "open"],
      ["metadata", "open"],
    ]);
    expect(telegram.calls.map((i) => i.text).sort()).toEqual([
      `Down: db. port ${closedPort} refused the connection`,
      "Down: metadata. 169.254.169.254 is a loopback, link-local or metadata address: never checked",
    ]);
    expect(await db.client.dataPoint.count({ where: { userId, collection: "monitor-ms", key: "nas" } })).toBe(1);

    // Still down: no new incident, nothing told. The port opens: resolved, told once.
    await run();
    expect(await db.client.dataEntity.count({ where: { appId, type: "Incident" } })).toBe(2);
    expect(telegram.calls).toHaveLength(2);
    await db.client.dataEntity.update({
      where: { appId_type_key: { appId, type: "Monitor", key: "db" } },
      data: { mine: { kind: "tcp", host: "nas.home.example", port: tcpPort } },
    });
    await run();
    expect(await entity("Monitor", "db")).toMatchObject({ status: "up" });
    const db1 = incidents.find((i) => (i.value as { subject: string }).subject === "db")!;
    expect(await entity("Incident", db1.key)).toMatchObject({ stage: "resolved", minutes: expect.any(Number) as unknown });
    expect(telegram.calls.at(-1)?.text).toMatch(/^Up again: db, after \d+ minutes\.$/);
    expect(await db.client.dataPoint.count({ where: { userId, collection: "monitor-ms", key: "nas" } })).toBe(3);
  });

  describe("http.check and net.check", () => {
    const context = (privateHosts: boolean): StepContext => ({
      runId: "00000000-0000-4000-8000-000000000001",
      userId,
      pipelineId: "00000000-0000-4000-8000-000000000002",
      stepId: "s",
      stepKey: "check",
      itemIndex: null,
      dryRun: false,
      recordUsage: () => undefined,
      attention: NO_ATTENTION,
      privateHosts,
    });
    const http = (input: Record<string, unknown>, privateHosts = true) =>
      new HttpCheckStep(testOptions()).execute(defaultCatalog().get("http.check")!.input.parse(input), context(privateHosts)) as Promise<Record<string, unknown>>;

    it("reaches a private address only from a field of mine; never metadata; says why down, never fails", async () => {
      const url = `http://nas.home.example:${webPort}/health`;
      expect(await http({ url })).toMatchObject({ state: "up", status: 200, refused: false, address: "127.0.0.1" });
      expect(await http({ url }, false)).toMatchObject({
        state: "down",
        refused: true,
        error: "nas.home.example is 127.0.0.1, a private address: only an address you typed in a field of mine (a Monitor's) may be private",
      });
      expect(await http({ url: "http://metadata.google.internal/computeMetadata/v1/" })).toMatchObject({ state: "down", refused: true });
      healthy = false;
      expect(await http({ url })).toMatchObject({ state: "down", status: 503, error: "status 503" });
      expect(await http({ url, expect: 503 })).toMatchObject({ state: "up", status: 503 });
      expect(await http({ url: "http://unknown.example/" })).toMatchObject({ state: "down", refused: false, error: "ENOTFOUND unknown.example" });
      const net = (input: Record<string, unknown>, privateHosts = true) =>
        new NetCheckStep(testOptions()).execute(defaultCatalog().get("net.check")!.input.parse(input), context(privateHosts)) as Promise<Record<string, unknown>>;
      expect(await net({ host: "nas.home.example", kind: "tcp", port: tcpPort })).toMatchObject({ state: "up" });
      expect(await net({ host: "nas.home.example", kind: "tcp", port: tcpPort }, false)).toMatchObject({ state: "down", refused: true });
      expect(await net({ host: "nas.home.example", kind: "tcp" })).toMatchObject({ state: "down", error: "a tcp check needs a port" });
      expect(await net({ host: "169.254.169.254", kind: "ping" })).toMatchObject({ state: "down", refused: true });
    });

    it("reads an https certificate's expiry; a self-signed one is down unless its errors are ignored", async () => {
      // A self-signed certificate for 30 days, made here (never a key in the repository).
      const dir = mkdtempSync(join(tmpdir(), "storm-tls-"));
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "30", "-subj", "/CN=nas.home.example", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
      const server = createHttpsServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (_req, res) => res.writeHead(204).end());
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const url = `https://nas.home.example:${(server.address() as AddressInfo).port}/`;
      try {
        expect(await http({ url })).toMatchObject({ state: "down", status: null, error: expect.stringMatching(/self.signed/i) as unknown });
        const checked = await http({ url, ignoreTlsErrors: true });
        expect(checked).toMatchObject({ state: "up", status: 204, certDays: expect.any(Number) as unknown });
        expect(checked.certDays).toBeGreaterThanOrEqual(28);
        expect(checked.certExpires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      } finally {
        await new Promise<void>((done) => server.close(() => done()));
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

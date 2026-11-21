import { KeyRing, payloadHash } from "@realentity/storm-crypto";
import { createPrismaConnection, type Prisma, type PrismaConnection, type Proposal } from "@realentity/storm-db";
import { entityItem, readAppSource, sealedAt } from "@realentity/storm-shared";
import { exampleYaml } from "@realentity/storm-shared/example-files";
import { defaultCatalog, PipelineCompiler } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { createServer, type Server } from "node:http";
import { type AddressInfo, BlockList } from "node:net";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { CredentialVault } from "../src/secrets/credential-vault";
import { SaveStep } from "../src/steps/data-steps";
import { ReadStep } from "../src/steps/entity-steps";
import { HttpRequestStep } from "../src/steps/http-steps";
import { MapStep } from "../src/steps/map-alert-steps";
import { Counting, createVersion } from "./support/test-steps";

jest.setTimeout(60_000);

const TOKEN = "Bearer hook-s3cret-5678";

/** A restart webhook: what it was sent. */
class Hooks {
  received: { method?: string; path?: string; authorization?: string }[] = [];
  port = 0;
  private server!: Server;
  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        this.received.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
        res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ queued: true }));
      });
    });
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", done));
    this.port = (this.server.address() as AddressInfo).port;
  }
  stop(): Promise<void> {
    return new Promise((done) => this.server.close(() => done()));
  }
}

// M58-T2: a monitor's runbooks proposed when it goes down and on an incident's Fix button; sent only after you Act
describe("examples/apps/server-ops.yaml: runbooks", () => {
  const keys = KeyRing.fromEnv(process.env);
  const compiler = new PipelineCompiler(defaultCatalog());
  const source = exampleYaml("apps/server-ops.yaml");
  const definition = readAppSource(source);
  let db: PrismaConnection;
  let userId: string;
  let appId: string;
  let hooks: Hooks;
  let telegram: Counting;
  let runner: PipelineRunner;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    hooks = new Hooks();
    await hooks.start();
  });

  beforeEach(async () => {
    hooks.received = [];
    const app = await db.client.app.create({ data: { userId, name: "Server ops" } });
    const version = await db.client.appVersion.create({ data: { appId: app.appId, version: 1, definition: {}, source } });
    await db.client.app.update({ where: { appId: app.appId }, data: { currentVersionId: version.appVersionId } });
    appId = app.appId;
    const vault = new CredentialVault(db.client, keys);
    const resolve = (host: string) =>
      host === "hooks.test" ? Promise.resolve([{ address: "127.0.0.1", family: 4 }]) : Promise.reject(new Error(`ENOTFOUND ${host}`));
    telegram = new Counting("notify.telegram", () => ({ sent: true }));
    runner = new PipelineRunner(
      db.client,
      defaultCatalog(),
      new ExecutorRegistry([new ReadStep(db.client), new SaveStep(db.client), new MapStep(), new HttpRequestStep({ resolve, blocked: new BlockList() }, vault), telegram]),
    );
    // Added on their forms: a monitor, its restart hook with its token (sealed, as the api seals it), an incident open.
    await db.client.dataEntity.create({ data: { appId, type: "Monitor", key: "web", value: { name: "web" }, mine: { kind: "http", url: "https://web.example" } } });
    const authorization = vault.sealFor(sealedAt(appId, "Runbook", "Restart web", "authorization"), TOKEN);
    await db.client.dataEntity.create({
      data: {
        appId,
        type: "Runbook",
        key: "Restart web",
        value: { name: "Restart web" },
        mine: { monitor: "web", method: "POST", url: `http://hooks.test:${hooks.port}/restart/web`, authorization } as unknown as Prisma.InputJsonObject,
      },
    });
    await db.client.dataEntity.create({
      data: { appId, type: "Incident", key: "web-1", value: { id: "web-1", title: "web is down", source: "monitor", subject: "web" }, stage: "open" },
    });
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.app.deleteMany();
  });

  afterAll(async () => {
    await hooks.stop();
    await db.close();
  });

  const incident = async (key = "web-1") => {
    const row = await db.client.dataEntity.findUniqueOrThrow({ where: { appId_type_key: { appId, type: "Incident", key } } });
    return { item: entityItem(row.value, row.mine), stage: row.stage };
  };
  const proposals = (runId: string): Promise<Proposal[]> => db.client.proposal.findMany({ where: { runId }, orderBy: [{ itemIndex: "asc" }] });
  /** What the inbox does: the first time, the hook's host is approved too, as a new target. */
  const decide = async (proposal: Proposal, status: "APPROVED" | "REJECTED") => {
    const payload = proposal.originalPayload as Prisma.InputJsonValue;
    const approvedNewTargets = status === "APPROVED" ? ["hooks.test"] : [];
    await db.client.proposal.update({ where: { proposalId: proposal.proposalId }, data: { status, finalPayload: payload, payloadHash: payloadHash(payload), approvedNewTargets } });
  };
  /** Advances the run to its end, or says which step failed and why. */
  const finish = async (runId: string) => {
    const status = await runner.advance(runId);
    if (status === "FAILED") {
      const failed = await db.client.step.findMany({ where: { runId, error: { not: null } }, select: { stepKey: true, error: true } });
      const run = await db.client.run.findUniqueOrThrow({ where: { runId } });
      throw new Error([run.summary, ...failed.map((f) => `${f.stepKey}: ${f.error}`)].join("\n"));
    }
    expect(status).toBe("DONE");
  };
  const opened = async () => {
    const versionId = await createVersion(db.client, userId, exampleYaml("fix-offer.yaml"), compiler, { app: definition });
    const { item } = await incident();
    const triggerData = { app: "Server ops", appId, type: "Incident", key: "web-1", item, before: null, changed: ["title"], stage: { from: null, to: "open" }, by: "pipeline" };
    return runner.start(versionId, { trigger: "event", triggerData });
  };

  it("an incident opened: its monitor's restart hook waits at the gate, the token never shown; sent once you Act", async () => {
    const runId = await opened();
    expect(await runner.advance(runId)).toBe("WAITING_FOR_USER");
    expect(hooks.received).toEqual([]);
    const [gate] = await proposals(runId);
    expect(gate.originalPayload).toMatchObject({ method: "POST", url: `http://hooks.test:${hooks.port}/restart/web` });
    expect(JSON.stringify(gate.originalPayload)).not.toContain("s3cret");

    await decide(gate, "APPROVED");
    await finish(runId);
    expect(hooks.received).toEqual([{ method: "POST", path: "/restart/web", authorization: TOKEN }]);
    expect(telegram.calls.map((c) => c.text)).toEqual(["Ran Restart web for web: it answered 202."]);
    expect((await incident()).stage).toBe("acknowledged");
    expect(JSON.stringify(await db.client.step.findMany({ where: { runId } }))).not.toContain("s3cret");
  });

  it("a hook without a token is sent without an Authorization header", async () => {
    await db.client.dataEntity.update({
      where: { appId_type_key: { appId, type: "Runbook", key: "Restart web" } },
      data: { mine: { monitor: "web", method: "POST", url: `http://hooks.test:${hooks.port}/restart/web?key=k1` } },
    });
    const runId = await opened();
    expect(await runner.advance(runId)).toBe("WAITING_FOR_USER");
    const [gate] = await proposals(runId);
    expect(gate.originalPayload).toMatchObject({ headers: {} });
    await decide(gate, "APPROVED");
    await finish(runId);
    expect(hooks.received).toEqual([{ method: "POST", path: "/restart/web?key=k1", authorization: undefined }]);
  });

  it("rejected at the gate: nothing sent, the incident stays open", async () => {
    const runId = await opened();
    expect(await runner.advance(runId)).toBe("WAITING_FOR_USER");
    await decide((await proposals(runId))[0], "REJECTED");
    await finish(runId);
    expect(hooks.received).toEqual([]);
    expect(telegram.calls).toEqual([]);
    expect((await incident()).stage).toBe("open");
  });

  it("Fix on an incident whose monitor has no runbook says so", async () => {
    await db.client.dataEntity.create({
      data: { appId, type: "Incident", key: "db-1", value: { id: "db-1", title: "The database is out of reach", source: "database", subject: "connection" }, stage: "open" },
    });
    const versionId = await createVersion(db.client, userId, exampleYaml("fix.yaml"), compiler, { app: definition });
    const { item } = await incident("db-1");
    const runId = await runner.start(versionId, { trigger: "event", triggerData: { app: "Server ops", appId, type: "Incident", key: "db-1", item, action: "Fix" } });
    await finish(runId);
    expect(hooks.received).toEqual([]);
    expect(telegram.calls.map((c) => c.text)).toEqual(["No runbook for connection: add one on its monitor's page, under Runbooks."]);
  });
});

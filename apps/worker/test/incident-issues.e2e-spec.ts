import { KeyRing, payloadHash, seal } from "@realentity/storm-crypto";
import { createPrismaConnection, type Prisma, type PrismaConnection, type Proposal } from "@realentity/storm-db";
import { entityItem, readAppSource } from "@realentity/storm-shared";
import { exampleYaml } from "@realentity/storm-shared/example-files";
import { defaultCatalog, PipelineCompiler } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { randomUUID } from "node:crypto";
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

const ACME_TOKEN = "github_pat_acme_0123";
const MINE_TOKEN = "github_pat_mine_4567";

/** GitHub's issues API as far as Server ops uses it: an issue created, its address answered. */
class FakeGitHub {
  requests: { path: string; authorization?: string; title?: string }[] = [];
  port = 0;
  private server!: Server;
  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { title?: string };
        const path = req.url ?? "/";
        this.requests.push({ path, authorization: req.headers.authorization, title: body.title });
        const repo = /^\/repos\/(.+)\/issues$/.exec(path)?.[1];
        res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ number: 7, html_url: `https://github.com/${repo}/issues/7` }));
      });
    });
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", done));
    this.port = (this.server.address() as AddressInfo).port;
  }
  stop(): Promise<void> {
    return new Promise((done) => this.server.close(() => done()));
  }
}

// M58-T2b: an incident's GitHub issue goes to its monitor's repository, or the default one, with its owner's token
describe("examples/apps/server-ops.yaml: incident issues", () => {
  const keys = KeyRing.fromEnv(process.env);
  const compiler = new PipelineCompiler(defaultCatalog());
  const appSource = exampleYaml("apps/server-ops.yaml");
  const definition = readAppSource(appSource);
  let db: PrismaConnection;
  let userId: string;
  let appId: string;
  let github: FakeGitHub;
  let telegram: Counting;
  let runner: PipelineRunner;
  let versionId: string;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    github = new FakeGitHub();
    await github.start();
  });

  const row = (type: string, key: string, value: Record<string, unknown>, mine?: Record<string, unknown>, stage?: string) =>
    db.client.dataEntity.create({ data: { appId, type, key, value: value as Prisma.InputJsonObject, ...(mine ? { mine: mine as Prisma.InputJsonObject } : {}), ...(stage ? { stage } : {}) } });
  const token = async (name: string, secret: string) => {
    const credentialId = randomUUID();
    await db.client.credential.create({ data: { credentialId, userId, name, kind: "API_KEY", allowedHosts: ["api.github.com"], ...seal(keys, credentialId, secret) } });
    return credentialId;
  };

  beforeEach(async () => {
    github.requests = [];
    const app = await db.client.app.create({ data: { userId, name: "Server ops" } });
    const version = await db.client.appVersion.create({ data: { appId: app.appId, version: 1, definition: {}, source: appSource } });
    await db.client.app.update({ where: { appId: app.appId }, data: { currentVersionId: version.appVersionId } });
    appId = app.appId;
    const vault = new CredentialVault(db.client, keys);
    const http = {
      resolve: (host: string) =>
        host === "api.github.com" ? Promise.resolve([{ address: "127.0.0.1", family: 4 }]) : Promise.reject(new Error(`ENOTFOUND ${host}`)),
      blocked: new BlockList(),
    };
    telegram = new Counting("notify.telegram", () => ({ sent: true }));
    runner = new PipelineRunner(
      db.client,
      defaultCatalog(),
      new ExecutorRegistry([new ReadStep(db.client, vault), new SaveStep(db.client), new MapStep(), new HttpRequestStep(http, vault), telegram]),
    );
    // Added on their pages: two GitHub owners, each with its token; a repository of each, mine the default; web's is acme's.
    await row("GitHubOwner", "acme", { name: "acme" }, { kind: "organization", token: await token("acme-github", ACME_TOKEN) });
    await row("GitHubOwner", "me", { name: "me" }, { kind: "user", token: await token("my-github", MINE_TOKEN) });
    await row("Repository", "acme/web-app", { name: "acme/web-app" });
    await row("Repository", "me/infra", { name: "me/infra" }, { default: true });
    await row("Monitor", "web", { name: "web" }, { kind: "http", url: "https://web.example", repository: "acme/web-app" });
    await row("Monitor", "nas", { name: "nas" }, { kind: "ping", host: "nas.example" });
    await row("Incident", "web-1", { id: "web-1", title: "web is down", source: "monitor", subject: "web", detail: "503" }, undefined, "open");
    await row("Incident", "nas-1", { id: "nas-1", title: "nas is down", source: "monitor", subject: "nas", detail: "no answer" }, undefined, "open");
    await row("Incident", "db-1", { id: "db-1", title: "The database is out of reach", source: "database", subject: "connection" }, undefined, "open");

    const source = exampleYaml("incident-issue.yaml").replaceAll("https://api.github.com/", `http://api.github.com:${github.port}/`);
    versionId = await createVersion(db.client, userId, source, compiler, { app: definition });
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.app.deleteMany();
    await db.client.credential.deleteMany();
  });

  afterAll(async () => {
    await github.stop();
    await db.close();
  });

  const incident = async (key: string) => {
    const found = await db.client.dataEntity.findUniqueOrThrow({ where: { appId_type_key: { appId, type: "Incident", key } } });
    return { item: entityItem(found.value, found.mine), stage: found.stage };
  };
  const press = async (key: string) => {
    const { item } = await incident(key);
    return runner.start(versionId, { trigger: "event", triggerData: { app: "Server ops", appId, type: "Incident", key, item, action: "Open issue" } });
  };
  const approve = async (runId: string) => {
    const [gate] = await db.client.proposal.findMany({ where: { runId } });
    const payload = gate.originalPayload as Prisma.InputJsonValue;
    await db.client.proposal.update({ where: { proposalId: gate.proposalId }, data: { status: "APPROVED", finalPayload: payload, payloadHash: payloadHash(payload) } });
    return gate;
  };
  const finish = async (runId: string) => {
    const status = await runner.advance(runId);
    if (status === "FAILED") {
      const failed = await db.client.step.findMany({ where: { runId, error: { not: null } }, select: { stepKey: true, error: true } });
      const run = await db.client.run.findUniqueOrThrow({ where: { runId } });
      throw new Error([run.summary, ...failed.map((f) => `${f.stepKey}: ${f.error}`)].join("\n"));
    }
    expect(status).toBe("DONE");
  };
  const proposed = async (key: string): Promise<{ runId: string; gate: Proposal }> => {
    const sent = github.requests.length;
    const runId = await press(key);
    expect(await runner.advance(runId)).toBe("WAITING_FOR_USER");
    expect(github.requests).toHaveLength(sent);
    return { runId, gate: await approve(runId) };
  };

  it("a monitor's incident: its repository, with that owner's token, never shown at the gate; acknowledged with the issue", async () => {
    const { runId, gate } = await proposed("web-1");
    expect(gate.originalPayload).toMatchObject({ method: "POST", url: `http://api.github.com:${github.port}/repos/acme/web-app/issues` });
    expect(JSON.stringify(gate.originalPayload)).not.toContain("github_pat");
    await finish(runId);
    expect(github.requests).toEqual([{ path: "/repos/acme/web-app/issues", authorization: `Bearer ${ACME_TOKEN}`, title: "web is down" }]);
    const after = await incident("web-1");
    expect(after.stage).toBe("acknowledged");
    expect(after.item).toMatchObject({ issueUrl: "https://github.com/acme/web-app/issues/7" });
    expect(JSON.stringify(await db.client.step.findMany({ where: { runId } }))).not.toContain("github_pat");
    expect(telegram.calls).toEqual([]);
  });

  it("a monitor without a repository, and the database's incident: the default repository, with its owner's token", async () => {
    for (const key of ["nas-1", "db-1"]) {
      const { runId } = await proposed(key);
      await finish(runId);
    }
    expect(github.requests.map((r) => [r.path, r.authorization])).toEqual([
      ["/repos/me/infra/issues", `Bearer ${MINE_TOKEN}`],
      ["/repos/me/infra/issues", `Bearer ${MINE_TOKEN}`],
    ]);
  });

  it("no default repository: you're told to choose one, nothing is sent", async () => {
    await db.client.dataEntity.update({ where: { appId_type_key: { appId, type: "Repository", key: "me/infra" } }, data: { mine: { default: false } } });
    const runId = await press("db-1");
    await finish(runId);
    expect(github.requests).toEqual([]);
    expect(telegram.calls.map((c) => c.text)).toEqual([
      "No repository for connection's issue: choose one on its monitor, or make one the default, under Repositories.",
    ]);
    expect((await incident("db-1")).stage).toBe("open");
  });

  it("a repository whose owner isn't added: you're told to add it", async () => {
    await db.client.dataEntity.delete({ where: { appId_type_key: { appId, type: "GitHubOwner", key: "acme" } } });
    const runId = await press("web-1");
    await finish(runId);
    expect(github.requests).toEqual([]);
    expect(telegram.calls.map((c) => c.text)).toEqual(["No GitHub owner acme for acme/web-app: add it with its token, under GitHub owners."]);
  });
});

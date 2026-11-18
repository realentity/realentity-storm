import { exampleYaml } from "@realentity/storm-shared/example-files";
import { KeyRing, seal } from "@realentity/storm-crypto";
import { createPrismaConnection, type Prisma, type PrismaConnection } from "@realentity/storm-db";
import { readAppSource, sealedAt } from "@realentity/storm-shared";
import { defaultCatalog, PipelineCompiler } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import sodium from "libsodium-wrappers";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AddressInfo, BlockList } from "node:net";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { CredentialVault } from "../src/secrets/credential-vault";
import { ReadStep } from "../src/steps/entity-steps";
import { HttpFetchStep, HttpRequestStep } from "../src/steps/http-steps";
import { MapStep } from "../src/steps/map-alert-steps";
import { createVersion } from "./support/test-steps";

jest.setTimeout(60_000);

const TOKEN = "github_pat_example_0123";

/** GitHub's API as far as Lockbox uses it: a scope's public key, its variables, secrets PUT, variables POST/PATCH. */
class FakeGitHub {
  requests: { method: string; path: string; authorization?: string; body?: Record<string, unknown> }[] = [];
  port = 0;
  readonly pair = sodium.crypto_box_keypair();
  private server!: Server;
  /** Variables GitHub has already; PATCHing BROKEN fails. */
  existing = [
    { name: "LOG", value: "info" },
    { name: "BROKEN", value: "x" },
  ];

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://api.github.com");
        const text = Buffer.concat(chunks).toString("utf8");
        this.requests.push({
          method: req.method ?? "",
          path: url.pathname + url.search,
          authorization: req.headers.authorization,
          ...(text ? { body: JSON.parse(text) as Record<string, unknown> } : {}),
        });
        const json = (status: number, body: unknown) =>
          res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
        const scope = "/repos/acme/api/actions";
        if (url.pathname === `${scope}/secrets/public-key`)
          return json(200, { key_id: "k-1", key: sodium.to_base64(this.pair.publicKey, sodium.base64_variants.ORIGINAL) });
        if (url.pathname === `${scope}/variables` && req.method === "GET") {
          return json(200, { total_count: this.existing.length, variables: url.searchParams.get("page") === "1" ? this.existing : [] });
        }
        if (url.pathname === `${scope}/variables/BROKEN`) return json(500, { message: "Server Error" });
        if (url.pathname.startsWith(`${scope}/secrets/`) && req.method === "PUT") return res.writeHead(201).end();
        if (url.pathname === `${scope}/variables` && req.method === "POST") return res.writeHead(201).end();
        if (url.pathname.startsWith(`${scope}/variables/`) && req.method === "PATCH") return res.writeHead(204).end();
        json(404, { message: "Not Found" });
      });
    });
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", done));
    this.port = (this.server.address() as AddressInfo).port;
  }

  stop(): Promise<void> {
    return new Promise((done) => this.server.close(() => done()));
  }

  opened(encrypted: string): string {
    return sodium.to_string(
      sodium.crypto_box_seal_open(
        sodium.from_base64(encrypted, sodium.base64_variants.ORIGINAL),
        this.pair.publicKey,
        this.pair.privateKey,
      ),
    );
  }
}

// M52-T10, M52-E1's run: Lockbox's Sync against a fake GitHub, auto-approved (M54), one failure not stopping the rest
describe("Lockbox sync", () => {
  const keys = KeyRing.fromEnv(process.env);
  let db: PrismaConnection;
  let userId: string;
  let github: FakeGitHub;

  beforeAll(async () => {
    await sodium.ready;
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    github = new FakeGitHub();
    await github.start();
  });

  const clean = async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.app.deleteMany();
    await db.client.credential.deleteMany();
    github.requests = [];
  };
  afterEach(clean);

  afterAll(async () => {
    await github.stop();
    await db.close();
  });

  /** Lockbox with its entries, a GitHub owner holding a token credential (allowed on `hosts`), and Sync saved. */
  async function lockbox(hosts = ["api.github.com"], kind = "user") {
    const appSource = exampleYaml("apps/lockbox.yaml");
    const app = await db.client.app.create({ data: { userId, name: "Lockbox" } });
    const version = await db.client.appVersion.create({ data: { appId: app.appId, version: 1, definition: {}, source: appSource } });
    await db.client.app.update({ where: { appId: app.appId }, data: { currentVersionId: version.appVersionId } });
    const vault = new CredentialVault(db.client, keys);
    const entry = async (key: string, fields: Record<string, unknown>, secret?: string) =>
      db.client.dataEntity.create({
        data: {
          appId: app.appId,
          type: "Entry",
          key,
          value: {
            id: key,
            project: "Acme",
            ...fields,
            ...(secret
              ? { secret: vault.sealFor(sealedAt(app.appId, "Entry", key, "secret"), secret) as unknown as Prisma.InputJsonObject }
              : {}),
          },
        },
      });
    await entry("e1", { name: "HOST", kind: "variable", path: "/_deploy", environment: "production", value: "deploy.example" });
    await entry("e2", { name: "DB", kind: "secret", path: "/_backend", environment: "production" }, "backend-db");
    await entry("e3", { name: "DB", kind: "secret", path: "/api", environment: "production" }, "api-db");
    await entry("e4", { name: "LOG", kind: "variable", path: "/api", environment: "production", value: "debug" });
    await entry("e5", { name: "BROKEN", kind: "variable", path: "/api", environment: "production", value: "y" });
    await entry("e6", { name: "STAGING_ONLY", kind: "secret", path: "/api", environment: "staging" }, "nope");
    await entry("e7", { name: "ELSEWHERE", kind: "secret", path: "/other", environment: "production" }, "nope");

    // M57: the owner's token is a credential of the user's, by id; no slot is bound.
    const credentialId = randomUUID();
    await db.client.credential.create({
      data: { credentialId, userId, name: "acme-github", kind: "API_KEY", allowedHosts: hosts, ...seal(keys, credentialId, TOKEN) },
    });
    await db.client.dataEntity.create({
      data: { appId: app.appId, type: "GitHubOwner", key: "acme", value: { name: "acme" }, mine: { kind, token: credentialId } },
    });

    // The pipeline as shipped, pointed at the fake; auto-approve on (Sync is the approval).
    const source = exampleYaml("lockbox-sync.yaml").replaceAll(
      "https://api.github.com/",
      `http://api.github.com:${github.port}/`,
    );
    const versionId = await createVersion(db.client, userId, source, new PipelineCompiler(defaultCatalog()), {
      app: readAppSource(appSource),
    });
    const { pipelineId } = await db.client.pipelineVersion.findUniqueOrThrow({ where: { pipelineVersionId: versionId } });
    await db.client.pipeline.update({ where: { pipelineId }, data: { autoApproveVersionId: versionId } });

    const http = {
      resolve: (host: string) =>
        host === "api.github.com" ? Promise.resolve([{ address: "127.0.0.1", family: 4 }]) : Promise.reject(new Error(`ENOTFOUND ${host}`)),
      blocked: new BlockList(),
    };
    const runner = new PipelineRunner(
      db.client,
      defaultCatalog(),
      new ExecutorRegistry([
        new ReadStep(db.client, vault),
        new MapStep(),
        new HttpFetchStep(db.client, http, vault),
        new HttpRequestStep(http, vault),
      ]),
    );
    const sync = async (bundle: Record<string, unknown>) => {
      const runId = await runner.start(versionId, {
        trigger: "manual",
        triggerData: { app: "Lockbox", type: "Bundle", key: bundle.name, item: bundle, action: "Sync" },
      });
      const status = await runner.advance(runId);
      return { status, run: await db.client.run.findUniqueOrThrow({ where: { runId } }), runId };
    };
    return { sync };
  }

  const BUNDLE = {
    name: "api production",
    project: "Acme",
    environment: "production",
    paths: ["/_deploy", "/_backend", "/api"],
    destination: "repository",
    owner: "acme",
    repository: "api",
  };

  it("sends the bundle's entries with its owner's token, a later path winning: secrets sealed to GitHub's key, variables created or updated", async () => {
    const { sync } = await lockbox();
    const { status, run, runId } = await sync(BUNDLE);
    expect(status).toBe("DONE");
    expect(run.summary).toMatch(/^1 item failed: updateVariable #\d+\./);
    const writes = github.requests.filter((r) => r.method !== "GET");
    expect(github.requests.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
    // Only /api's DB (the later path), sealed so only GitHub's key opens it; nothing of staging or another path.
    const put = writes.filter((r) => r.method === "PUT");
    expect(put.map((r) => r.path)).toEqual(["/repos/acme/api/actions/secrets/DB"]);
    expect(put[0].body!.key_id).toBe("k-1");
    expect(github.opened(put[0].body!.encrypted_value as string)).toBe("api-db");
    // HOST is new: created; LOG exists: updated; BROKEN's update fails, and didn't stop the others.
    const variables = writes.filter((r) => r.method !== "PUT").map((r) => [r.method, r.path, r.body?.value]);
    expect(variables).toHaveLength(3);
    expect(variables).toEqual(
      expect.arrayContaining([
        ["POST", "/repos/acme/api/actions/variables", "deploy.example"],
        ["PATCH", "/repos/acme/api/actions/variables/LOG", "debug"],
        ["PATCH", "/repos/acme/api/actions/variables/BROKEN", "y"],
      ]),
    );
    // No proposal waited, and nothing stored holds a secret's value or the token.
    expect(await db.client.proposal.count({ where: { runId, status: "PENDING_REVIEW" } })).toBe(0);
    const stored = JSON.stringify(await db.client.step.findMany({ where: { runId } }));
    expect(stored).not.toContain("api-db");
    expect(stored).not.toContain("backend-db");
    expect(stored).not.toContain(TOKEN);
  });

  // M57-I1: the token is sent only where its credential allows; an organization bundle's owner is an organization
  it("sends nothing when the owner's credential isn't allowed on GitHub, or an organization bundle's owner is a user", async () => {
    const { sync } = await lockbox(["example.com"]);
    const refused = await sync(BUNDLE);
    expect(refused.status).toBe("FAILED");
    expect(JSON.stringify(await db.client.step.findMany({ where: { runId: refused.runId } }))).toContain("not allowed on api.github.com");
    expect(github.requests).toHaveLength(0);

    await clean();
    const user = await (await lockbox()).sync({ ...BUNDLE, destination: "organization", visibility: "private" });
    expect(user.status).toBe("FAILED");
    expect(JSON.stringify(await db.client.step.findMany({ where: { runId: user.runId } }))).toContain("acme is a user");
    expect(github.requests).toHaveLength(0);
  });
});

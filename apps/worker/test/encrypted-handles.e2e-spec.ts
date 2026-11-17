import { KeyRing, payloadHash } from "@realentity/storm-crypto";
import { createPrismaConnection, type Prisma, type PrismaConnection } from "@realentity/storm-db";
import { readAppSource, sealedAt, sealedToken } from "@realentity/storm-shared";
import { TestEnvironment } from "@realentity/storm-testing";
import { createServer, type Server } from "node:http";
import { type AddressInfo, BlockList } from "node:net";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { CredentialVault } from "../src/secrets/credential-vault";
import { ReadStep } from "../src/steps/entity-steps";
import { transformsReady } from "../src/secrets/transforms";
import sodium from "libsodium-wrappers";
import { HttpRequestStep } from "../src/steps/http-steps";
import { catalog, compiler, Counting, createVersion } from "./support/test-steps";

jest.setTimeout(60_000);

const SECRET = "ghp_s3cret-value-1234";

const APP = `
name: Deploy secrets
types:
  Secret:
    key: name
    fields:
      name: { type: text, required: true }
      value: { type: text, encrypted: true }
`;

const PIPELINE = (port: number) => `
name: Sync secrets
app: Deploy secrets
policy: { allowedDomains: [api.test] }
steps:
  - id: read
    type: data.read
    with: { type: Secret }
  - id: note
    type: test.note
    with: { text: "Read: {{read.items}}" }
  - id: put
    type: http.request
    forEach: "{{read.items}}"
    with:
      method: PUT
      url: "http://api.test:${port}/secrets/{{item.name}}"
      headers: { Authorization: "token {{item.value}}" }
      body: { value: "{{item.value}}", hash: "{{item.value.hash}}" }
`;

/** An API that takes a secret and, as some do, echoes it back. */
class Api {
  received: { authorization?: string; body: string }[] = [];
  port = 0;
  private server!: Server;
  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        this.received.push({ authorization: req.headers.authorization, body });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ stored: JSON.parse(body) as unknown }));
      });
    });
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", done));
    this.port = (this.server.address() as AddressInfo).port;
  }
  stop(): Promise<void> {
    return new Promise((done) => this.server.close(() => done()));
  }
}

// M52-I1 (sending), M52-S1: a pipeline sends an encrypted field with http.request; nothing else ever holds its value
describe("encrypted fields sent by http.request", () => {
  const keys = KeyRing.fromEnv(process.env);
  let db: PrismaConnection;
  let userId: string;
  let api: Api;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    api = new Api();
    await api.start();
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.app.deleteMany();
  });

  afterAll(async () => {
    await api.stop();
    await db.close();
  });

  it("opens it only as the approved request is sent: the gate, the LLM step, the run and the answer hold ***", async () => {
    const app = await db.client.app.create({ data: { userId, name: "Deploy secrets" } });
    const version = await db.client.appVersion.create({ data: { appId: app.appId, version: 1, definition: {}, source: APP } });
    await db.client.app.update({ where: { appId: app.appId }, data: { currentVersionId: version.appVersionId } });
    const vault = new CredentialVault(db.client, keys);
    const sealed = vault.sealFor(sealedAt(app.appId, "Secret", "DEPLOY_TOKEN", "value"), SECRET);
    await db.client.dataEntity.create({
      data: {
        appId: app.appId,
        type: "Secret",
        key: "DEPLOY_TOKEN",
        value: { name: "DEPLOY_TOKEN", value: sealed as unknown as Prisma.InputJsonObject },
      },
    });

    const versionId = await createVersion(db.client, userId, PIPELINE(api.port), compiler, { app: readAppSource(APP) });
    const note = new Counting("test.note", (input) => ({ text: input.text }));
    const resolve = (host: string) =>
      host === "api.test" ? Promise.resolve([{ address: "127.0.0.1", family: 4 }]) : Promise.reject(new Error(`ENOTFOUND ${host}`));
    const runner = new PipelineRunner(
      db.client,
      catalog,
      new ExecutorRegistry([new ReadStep(db.client), note, new HttpRequestStep({ resolve, blocked: new BlockList() }, vault)]),
    );
    const runId = await runner.start(versionId, { trigger: "manual" });
    expect(await runner.advance(runId)).toBe("WAITING_FOR_USER");

    // The step that isn't http.request saw ***, not even the ciphertext.
    expect(note.calls[0].text).toContain('"value":"***"');
    expect(note.calls[0].text).not.toContain("ciphertext");
    // Nothing sent before the gate; the gate's payload holds the sealed value, never the text.
    expect(api.received).toEqual([]);
    const proposal = await db.client.proposal.findFirstOrThrow({ where: { runId } });
    expect(JSON.stringify(proposal.originalPayload)).not.toContain(SECRET);
    expect(JSON.stringify(proposal.originalPayload)).toContain("{{sealed:");

    await db.client.proposal.update({
      where: { proposalId: proposal.proposalId },
      data: {
        status: "APPROVED",
        finalPayload: proposal.originalPayload as Prisma.InputJsonValue,
        payloadHash: payloadHash(proposal.originalPayload),
      },
    });
    expect(await runner.advance(runId)).toBe("DONE");

    // Sent as the text, header and body; its hash as written.
    expect(api.received.map((r) => ({ ...r, body: JSON.parse(r.body) as unknown }))).toEqual([
      { authorization: `token ${SECRET}`, body: { value: SECRET, hash: sealed.$sealed.hash } },
    ]);
    // The answer echoed it: masked. No step's input, output or error holds it.
    const steps = await db.client.step.findMany({ where: { runId } });
    const put = steps.find((s) => s.stepKey === "put");
    expect(put?.output).toMatchObject({ json: { stored: { value: "***" } } });
    expect(JSON.stringify(steps)).not.toContain(SECRET);
  });

  // M52-T9 (I1 with transforms): GitHub's way, the value sealed to the repository's key, and a plain value as base64
  it("seals the opened value to a public key with sealedBox, and base64s a plain one", async () => {
    api.received = [];
    await transformsReady();
    const pair = sodium.crypto_box_keypair();
    const publicKey = sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL);
    const app = await db.client.app.create({ data: { userId, name: "Deploy secrets" } });
    const version = await db.client.appVersion.create({ data: { appId: app.appId, version: 1, definition: {}, source: APP } });
    await db.client.app.update({ where: { appId: app.appId }, data: { currentVersionId: version.appVersionId } });
    const vault = new CredentialVault(db.client, keys);
    const sealed = vault.sealFor(sealedAt(app.appId, "Secret", "DEPLOY_TOKEN", "value"), SECRET);
    await db.client.dataEntity.create({
      data: {
        appId: app.appId,
        type: "Secret",
        key: "DEPLOY_TOKEN",
        value: { name: "DEPLOY_TOKEN", value: sealed as unknown as Prisma.InputJsonObject },
      },
    });
    const source = `
name: Sync to GitHub
app: Deploy secrets
policy: { allowedDomains: [api.test] }
steps:
  - id: key
    type: test.note
    with: { text: "${publicKey}" }
  - id: read
    type: data.read
    with: { type: Secret }
  - id: put
    type: http.request
    forEach: "{{read.items}}"
    with:
      method: PUT
      url: "http://api.test:${api.port}/secrets/{{item.name}}"
      headers: { Authorization: "Basic {{item.value | base64}}", X-Name: "{{item.name | base64}}" }
      body: { encrypted_value: "{{item.value | sealedBox: key.text}}" }
`;
    const versionId = await createVersion(db.client, userId, source, compiler, { app: readAppSource(APP) });
    const resolve = (host: string) =>
      host === "api.test" ? Promise.resolve([{ address: "127.0.0.1", family: 4 }]) : Promise.reject(new Error(`ENOTFOUND ${host}`));
    const runner = new PipelineRunner(
      db.client,
      catalog,
      new ExecutorRegistry([
        new Counting("test.note", (input) => ({ text: input.text })),
        new ReadStep(db.client),
        new HttpRequestStep({ resolve, blocked: new BlockList() }, vault),
      ]),
    );
    const runId = await runner.start(versionId, { trigger: "manual" });
    expect(await runner.advance(runId)).toBe("WAITING_FOR_USER");
    const proposal = await db.client.proposal.findFirstOrThrow({ where: { runId } });
    // The gate: a plain value already transformed; the encrypted one still sealed, its transform with it.
    expect(proposal.originalPayload).toMatchObject({ headers: { "X-Name": Buffer.from("DEPLOY_TOKEN").toString("base64") } });
    expect(JSON.stringify(proposal.originalPayload)).toMatch(/"Authorization":"Basic \{\{sealed:[A-Za-z0-9_-]+\|base64\}\}"/);
    expect(JSON.stringify(proposal.originalPayload)).toMatch(/\{\{sealed:[A-Za-z0-9_-]+\|sealedBox:[A-Za-z0-9_-]+\}\}/);
    await db.client.proposal.update({
      where: { proposalId: proposal.proposalId },
      data: {
        status: "APPROVED",
        finalPayload: proposal.originalPayload as Prisma.InputJsonValue,
        payloadHash: payloadHash(proposal.originalPayload),
      },
    });
    expect(await runner.advance(runId)).toBe("DONE");

    // Only the key's owner opens what was sent; nothing in the request or the run holds the value.
    const [sent] = api.received;
    expect(sent.authorization).toBe(`Basic ${Buffer.from(SECRET).toString("base64")}`);
    expect(sent.body).not.toContain(SECRET);
    const { encrypted_value } = JSON.parse(sent.body) as { encrypted_value: string };
    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(encrypted_value, sodium.base64_variants.ORIGINAL),
      pair.publicKey,
      pair.privateKey,
    );
    expect(sodium.to_string(opened)).toBe(SECRET);
    expect(JSON.stringify(await db.client.step.findMany({ where: { runId } }))).not.toContain(SECRET);
  });

  it("refuses a value that holds a {{cred:…}} reference: it never brings a credential in", async () => {
    api.received = [];
    const vault = new CredentialVault(db.client, keys);
    const handle = vault.sealFor(sealedAt("app", "Secret", "X", "value"), "x{{cred:github}}");
    const resolve = () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]);
    const step = new HttpRequestStep({ resolve, blocked: new BlockList() }, vault);
    const input = catalog
      .get("http.request")!
      .input.parse({ method: "POST", url: `http://api.test:${api.port}/secrets/X`, headers: { Authorization: sealedToken(handle) } });
    await expect(step.execute(input, { userId, allowedDomains: ["api.test"] } as never)).rejects.toThrow(
      "can't hold a {{cred:…}} reference",
    );
    expect(api.received).toEqual([]);
  });
});

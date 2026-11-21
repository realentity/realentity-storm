import { KeyRing, payloadHash } from "@realentity/storm-crypto";
import { createPrismaConnection, type Prisma, type PrismaConnection } from "@realentity/storm-db";
import { entityItem, readAppSource, sealedAt } from "@realentity/storm-shared";
import { exampleYaml } from "@realentity/storm-shared/example-files";
import { defaultCatalog, PipelineCompiler } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { createServer, type Server } from "node:http";
import { type AddressInfo, BlockList } from "node:net";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { CredentialVault } from "../src/secrets/credential-vault";
import { DedupeStep, SaveStep } from "../src/steps/data-steps";
import { ReadStep } from "../src/steps/entity-steps";
import { HttpRequestStep } from "../src/steps/http-steps";
import { MapStep } from "../src/steps/map-alert-steps";
import { Counting, createVersion } from "./support/test-steps";

jest.setTimeout(60_000);

const TOKEN = "made-up-token";

/** A Mastodon server's statuses API: what it was sent. */
class Mastodon {
  received: { authorization?: string; body: { status?: string; visibility?: string } }[] = [];
  port = 0;
  private server!: Server;
  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        this.received.push({ authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as { status?: string } });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "1", url: "https://social.test/@me/1" }));
      });
    });
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", done));
    this.port = (this.server.address() as AddressInfo).port;
  }
  stop(): Promise<void> {
    return new Promise((done) => this.server.close(() => done()));
  }
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

// M58-T8: the Announcements App: a new release of your project, a post drafted, posted to Mastodon once approved
describe("examples/apps/announcements.yaml", () => {
  const keys = KeyRing.fromEnv(process.env);
  const compiler = new PipelineCompiler(defaultCatalog());
  const appSource = exampleYaml("apps/announcements.yaml");
  const definition = readAppSource(appSource);
  let db: PrismaConnection;
  let userId: string;
  let appId: string;
  let mastodon: Mastodon;
  let feeds: Counting;
  let draft: Counting;
  let runner: PipelineRunner;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    mastodon = new Mastodon();
    await mastodon.start();
  });

  beforeEach(async () => {
    mastodon.received = [];
    const app = await db.client.app.create({ data: { userId, name: "Announcements" } });
    const version = await db.client.appVersion.create({ data: { appId: app.appId, version: 1, definition: {}, source: appSource } });
    await db.client.app.update({ where: { appId: app.appId }, data: { currentVersionId: version.appVersionId } });
    appId = app.appId;
    const vault = new CredentialVault(db.client, keys);
    await db.client.dataEntity.create({ data: { appId, type: "Project", key: "acme/tool", value: { repository: "acme/tool" }, mine: { hashtags: "#opensource" } } });
    const token = vault.sealFor(sealedAt(appId, "Account", "@me@social.test", "token"), TOKEN);
    await db.client.dataEntity.create({
      data: {
        appId,
        type: "Account",
        key: "@me@social.test",
        value: { name: "@me@social.test" },
        mine: { postUrl: `http://social.test:${mastodon.port}/api/v1/statuses`, token } as unknown as Prisma.InputJsonObject,
      },
    });
    feeds = new Counting("http.fetch", (input) => ({
      items: [
        { title: "v1.4.0", url: "https://github.com/acme/tool/releases/tag/v1.4.0", published: hoursAgo(2), summary: "Faster builds.", id: "1", source: "github.com" },
        { title: "v1.3.0", url: "https://github.com/acme/tool/releases/tag/v1.3.0", published: hoursAgo(24 * 30), summary: "Old.", id: "2", source: "github.com" },
      ],
      json: null,
      text: "",
      documents: [{ url: input.url as string, status: 200, notModified: false, contentType: "application/atom+xml", title: "Releases", truncated: false }],
    }));
    draft = new Counting("llm.generate", () => ({ text: "acme/tool v1.4.0 is out: faster builds. https://github.com/acme/tool/releases/tag/v1.4.0 #opensource" }));
    const resolve = (host: string) => (host === "social.test" ? Promise.resolve([{ address: "127.0.0.1", family: 4 }]) : Promise.reject(new Error(`ENOTFOUND ${host}`)));
    runner = new PipelineRunner(
      db.client,
      defaultCatalog(),
      new ExecutorRegistry([new ReadStep(db.client), new SaveStep(db.client), new MapStep(), new DedupeStep(db.client), new HttpRequestStep({ resolve, blocked: new BlockList() }, vault), feeds, draft]),
    );
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.app.deleteMany();
  });

  afterAll(async () => {
    await mastodon.stop();
    await db.close();
  });

  const releases = async () =>
    Object.fromEntries(
      (await db.client.dataEntity.findMany({ where: { appId, type: "Release" }, orderBy: { key: "asc" } })).map((r) => [r.key, { stage: r.stage, ...entityItem(r.value, r.mine) }]),
    );
  const run = async () =>
    runner.start(await createVersion(db.client, userId, exampleYaml("announce.yaml"), compiler, { app: definition }), { trigger: "schedule", triggerData: {} });
  /** Each gate as the inbox decides it, the text edited at the gate; the server's host approved the first time. */
  const decide = async (runId: string, approve = true, edit = (status: string) => status) => {
    for (let status = await runner.advance(runId); status !== "DONE"; status = await runner.advance(runId)) {
      if (status === "FAILED") {
        const failed = await db.client.step.findMany({ where: { runId, error: { not: null } }, select: { stepKey: true, error: true } });
        throw new Error(failed.map((f) => `${f.stepKey}: ${f.error}`).join("\n"));
      }
      expect(status).toBe("WAITING_FOR_USER");
      for (const p of await db.client.proposal.findMany({ where: { runId, status: "PENDING_REVIEW" } })) {
        const offered = p.originalPayload as { body: { status: string } };
        const payload = { ...offered, body: { ...offered.body, status: edit(offered.body.status) } } as Prisma.InputJsonValue;
        await db.client.proposal.update({
          where: { proposalId: p.proposalId },
          data: { status: approve ? "APPROVED" : "REJECTED", finalPayload: payload, payloadHash: payloadHash(payload), approvedNewTargets: approve ? ["social.test"] : [] },
        });
      }
    }
  };

  it("a new release: a post drafted, edited at the gate (the token never shown), posted to your account; the Release is posted", async () => {
    const runId = await run();
    expect(await runner.advance(runId)).toBe("WAITING_FOR_USER");
    expect(feeds.calls.map((c) => c.url)).toEqual(["https://github.com/acme/tool/releases.atom"]);
    expect(draft.calls).toHaveLength(1);
    const [gate] = await db.client.proposal.findMany({ where: { runId } });
    expect(gate.originalPayload).toMatchObject({ method: "POST", url: `http://social.test:${mastodon.port}/api/v1/statuses` });
    expect(JSON.stringify(gate.originalPayload)).not.toContain(TOKEN);
    expect(await releases()).toMatchObject({ "https://github.com/acme/tool/releases/tag/v1.4.0": { stage: "drafted", title: "acme/tool v1.4.0", repository: "acme/tool" } });

    await decide(runId, true, (status) => `${status} 🎉`);
    expect(mastodon.received).toEqual([{ authorization: `Bearer ${TOKEN}`, body: { status: expect.stringMatching(/ 🎉$/) as string, visibility: "public" } }]);
    expect((await releases())["https://github.com/acme/tool/releases/tag/v1.4.0"]).toMatchObject({ stage: "posted", link: "https://social.test/@me/1" });
    expect(JSON.stringify(await db.client.step.findMany({ where: { runId } }))).not.toContain(TOKEN);
  });

  it("rejected at the gate: nothing posted, the Release stays drafted; the next hour it isn't drafted again", async () => {
    await decide(await run(), false);
    expect(mastodon.received).toEqual([]);
    expect((await releases())["https://github.com/acme/tool/releases/tag/v1.4.0"]).toMatchObject({ stage: "drafted" });
    await decide(await run());
    expect(draft.calls).toHaveLength(1);
    expect(mastodon.received).toEqual([]);
  });

  it("no account: nothing drafted or posted", async () => {
    await db.client.dataEntity.deleteMany({ where: { appId, type: "Account" } });
    await decide(await run());
    expect(draft.calls).toEqual([]);
    expect(mastodon.received).toEqual([]);
  });
});

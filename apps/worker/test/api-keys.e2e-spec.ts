import { KeyRing, payloadHash, seal } from "@realentity/storm-crypto";
import { createPrismaConnection, type Prisma, type PrismaConnection } from "@realentity/storm-db";
import { defaultCatalog, PipelineCompiler } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo, BlockList } from "node:net";
import { join } from "node:path";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry, NO_ATTENTION, type StepContext } from "../src/runner/step-executor";
import { CredentialVault } from "../src/secrets/credential-vault";
import { HttpFetchStep, HttpRequestStep } from "../src/steps/http-steps";
import { Counting, createVersion } from "./support/test-steps";

const KEY = "sk-live-7f3a9c2e";

/** An API that wants a key (Bearer or ?appid=), and echoes it back, as some do in their errors. */
class Api {
  requests: { host: string; path: string; method?: string; authorization?: string; body?: string }[] = [];
  private server!: Server;
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => this.answer(req, res, Buffer.concat(chunks).toString("utf8")));
    });
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", done));
    this.port = (this.server.address() as AddressInfo).port;
  }

  private answer(req: IncomingMessage, res: ServerResponse, body: string): unknown {
    {
      const host = (req.headers.host ?? "").split(":")[0];
      const url = new URL(req.url ?? "/", `http://${host}`);
      this.requests.push({ host, path: url.pathname + url.search, method: req.method, authorization: req.headers.authorization, ...(body ? { body } : {}) });
      const json = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json", etag: '"e1"' }).end(JSON.stringify(body));
      if (url.pathname === "/v1/me") return req.headers.authorization === `Bearer ${KEY}` ? json(200, { user: "ana", token: KEY }) : json(401, { error: "no key" });
      if (url.pathname === "/weather") return url.searchParams.get("appid") === KEY ? json(200, { list: [{ temp: 8 }] }) : json(401, { error: "no key" });
      if (url.pathname === "/to-me") return res.writeHead(302, { location: "/v1/me" }).end();
      if (url.pathname === "/to-other") return res.writeHead(302, { location: `http://other.test:${this.port}/v1/me` }).end();
      if (url.pathname === "/loop") return res.writeHead(302, { location: url.pathname + url.search }).end();
      if (url.pathname === "/repos/me/infra/issues" && req.method === "POST") {
        if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { message: "Bad credentials" });
        const issue = JSON.parse(body) as { title?: string };
        return issue.title ? json(201, { number: 7, title: issue.title }) : json(422, { message: `title missing (token ${KEY})` });
      }
      if (url.pathname === "/moved") return res.writeHead(307, { location: `http://other.test:${this.port}/repos/me/infra/issues` }).end();
      res.writeHead(404).end();
    }
  }

  url(path: string, host = "api.test"): string {
    return `http://${host}:${this.port}${path}`;
  }

  stop(): Promise<void> {
    return new Promise((done) => this.server.close(() => done()));
  }
}

const resolve = (host: string) =>
  ["api.test", "other.test"].includes(host) ? Promise.resolve([{ address: "127.0.0.1", family: 4 }]) : Promise.reject(new Error(`ENOTFOUND ${host}`));

// M29-T5: API keys in http.fetch
describe("M29: http.fetch with an API key", () => {
  let db: PrismaConnection;
  let userId: string;
  let api: Api;
  let step: HttpFetchStep;
  const keys = KeyRing.fromEnv(process.env);

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    api = new Api();
    await api.start();
  });

  beforeEach(async () => {
    api.requests = [];
    const credentialId = randomUUID();
    await db.client.credential.create({ data: { credentialId, userId, name: "weather-api", kind: "API_KEY", allowedHosts: ["api.test"], ...seal(keys, credentialId, KEY) } });
    const blocked = new BlockList();
    blocked.addSubnet("10.0.0.0", 8, "ipv4");
    step = new HttpFetchStep(db.client, { blocked, resolve }, new CredentialVault(db.client, keys));
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.credential.deleteMany();
    await db.client.httpCache.deleteMany();
  });

  afterAll(async () => {
    await api.stop();
    await db.close();
  });

  const context: () => StepContext = () => ({
    runId: "00000000-0000-4000-8000-000000000001",
    userId,
    pipelineId: "00000000-0000-4000-8000-000000000002",
    stepId: "s",
    stepKey: "k",
    itemIndex: null,
    dryRun: false,
    recordUsage: () => undefined,
    attention: NO_ATTENTION,
    allowedDomains: ["api.test", "other.test"],
  });
  type Output = { items: unknown[]; json: unknown; text: string; documents: { url: string }[] };
  const fetch = (raw: Record<string, unknown>) => step.execute(defaultCatalog().get("http.fetch")!.input.parse(raw), context()) as Promise<Output>;

  it("M29-I4: a Bearer header and a query key, opened for the address's host; outputs name the address as written", async () => {
    const me = await fetch({ url: api.url("/v1/me"), headers: { Authorization: "Bearer {{cred:weather-api}}" } });
    expect(me.json).toEqual({ user: "ana", token: "•••" });
    expect(api.requests[0]?.authorization).toBe(`Bearer ${KEY}`);

    const weather = await fetch({ url: api.url("/weather?units=metric"), query: { appid: "{{cred:weather-api}}" }, itemsAt: "list" });
    expect(weather.items).toEqual([{ temp: 8, source: api.url("/weather?units=metric") }]);
    expect(weather.documents[0]?.url).toBe(api.url("/weather?units=metric"));
    expect(api.requests[1]?.path).toBe(`/weather?units=metric&appid=${KEY}`);

    // Same host after a redirect: fine.
    expect((await fetch({ url: api.url("/to-me"), headers: { Authorization: "Bearer {{cred:weather-api}}" } })).json).toMatchObject({ user: "ana" });
    expect(JSON.stringify([me, weather])).not.toContain(KEY);
    // A read with a key isn't cached (the API sent an ETag).
    expect(await db.client.httpCache.count()).toBe(0);
    expect((await db.client.credential.findFirstOrThrow()).lastUsedAt).not.toBeNull();
  });

  it("M29-S1: never to a host the credential doesn't allow, before sending or after a redirect; the key masked in errors", async () => {
    const bearer = { Authorization: "Bearer {{cred:weather-api}}" };
    await expect(fetch({ url: api.url("/v1/me", "other.test"), headers: bearer })).rejects.toThrow('Credential "weather-api" is not allowed on other.test');
    expect(api.requests).toEqual([]);

    await expect(fetch({ url: api.url("/to-other"), headers: bearer })).rejects.toThrow('Credential "weather-api" is not allowed on other.test');
    expect(api.requests.map((r) => r.host)).toEqual(["api.test"]);

    const loop = fetch({ url: api.url("/loop"), query: { appid: "{{cred:weather-api}}" } });
    await expect(loop).rejects.toThrow(/more than 5 redirects/);
    await expect(loop).rejects.not.toThrow(KEY);

    await expect(fetch({ url: api.url("/v1/me"), headers: { Authorization: "Bearer {{cred:nothing}}" } })).rejects.toThrow('No credential named "nothing"');
    await expect(new HttpFetchStep(db.client, { resolve }).execute(defaultCatalog().get("http.fetch")!.input.parse({ url: api.url("/v1/me"), headers: bearer }), context())).rejects.toThrow(
      "http.fetch can't use credentials here",
    );
  });

  it("through a run: the step's input keeps {{cred:…}}, its output never has the key", async () => {
    const versionId = await createVersion(
      db.client,
      userId,
      `
name: Me
policy: { allowedDomains: [api.test] }
steps:
  - id: me
    type: http.fetch
    with: { url: "${api.url("/v1/me")}", headers: { Authorization: "Bearer {{cred:weather-api}}" } }
  - id: tell
    type: notify.telegram
    with: { text: "Me: {{me.json}}" }
`,
      new PipelineCompiler(defaultCatalog()),
    );
    const telegram = new Counting("notify.telegram", () => ({ sent: true }));
    const runner = new PipelineRunner(db.client, defaultCatalog(), new ExecutorRegistry([step, telegram]));
    const runId = await runner.start(versionId, { trigger: "manual" });
    expect(await runner.advance(runId)).toBe("DONE");
    const steps = await db.client.step.findMany({ where: { runId } });
    expect(JSON.stringify(steps)).not.toContain(KEY);
    expect(JSON.stringify(steps.find((s) => s.stepKey === "me")?.input)).toContain("{{cred:weather-api}}");
    expect(JSON.stringify(telegram.calls)).not.toContain(KEY);
  });

  // M29-T6
  describe("http.request", () => {
    const request = (raw: Record<string, unknown>) =>
      new HttpRequestStep({ resolve, blocked: new BlockList() }, new CredentialVault(db.client, keys)).execute(
        defaultCatalog().get("http.request")!.input.parse(raw),
        { ...context(), allowedDomains: ["api.test"] },
      ) as Promise<{ status: number; json: unknown; text: string }>;
    const issue = () => ({ method: "POST", url: api.url("/repos/me/infra/issues"), headers: { Authorization: "Bearer {{cred:weather-api}}" } });

    it("M29-I5: a POST with a JSON body and a key; an answer other than 2xx fails the step, the key masked; no redirect followed", async () => {
      expect(await request({ ...issue(), body: { title: "Release watch failed", labels: ["storm"] } })).toEqual({
        status: 201,
        json: { number: 7, title: "Release watch failed" },
        text: '{"number":7,"title":"Release watch failed"}',
      });
      expect(api.requests[0]).toMatchObject({ method: "POST", authorization: `Bearer ${KEY}`, body: '{"title":"Release watch failed","labels":["storm"]}' });

      const refused = request({ ...issue(), body: {} });
      await expect(refused).rejects.toThrow('answered 422: {"message":"title missing (token •••)"}');
      await expect(refused).rejects.not.toThrow(KEY);
      await expect(request({ ...issue(), url: api.url("/moved"), body: { title: "x" } })).rejects.toThrow("answered 307");
      expect(api.requests.map((r) => r.host)).not.toContain("other.test");
      await expect(request({ method: "DELETE", url: api.url("/repos/me/infra/issues/7", "other.test") })).rejects.toThrow("other.test isn't in the pipeline's allowedDomains");
    });

    it("M29-I6: pipelines/failed-run-issue.yaml: the issue waits at its gate with {{cred:…}}, and is created once I approve", async () => {
      const source = readFileSync(join(__dirname, "../../../pipelines/failed-run-issue.yaml"), "utf8").replace("https://api.github.com/", `http://api.github.com:${api.port}/`);
      const versionId = await createVersion(db.client, userId, source, new PipelineCompiler(defaultCatalog()));
      await db.client.credential.updateMany({ data: { name: "github", allowedHosts: ["api.github.com"] } });
      const github = (host: string) => (host === "api.github.com" ? Promise.resolve([{ address: "127.0.0.1", family: 4 }]) : Promise.reject(new Error(`ENOTFOUND ${host}`)));
      const runner = new PipelineRunner(db.client, defaultCatalog(), new ExecutorRegistry([new HttpRequestStep({ resolve: github, blocked: new BlockList() }, new CredentialVault(db.client, keys))]));
      const runId = await runner.start(versionId, {
        trigger: "event",
        triggerData: { runId: "r-1", pipeline: "Release watch", status: "FAILED", summary: "github.com answered 503", outputs: {} },
      });
      expect(await runner.advance(runId)).toBe("WAITING_FOR_USER");
      expect(api.requests).toEqual([]);
      const proposal = await db.client.proposal.findFirstOrThrow({ where: { runId } });
      const payload = proposal.originalPayload as Record<string, unknown>;
      expect(payload).toMatchObject({
        method: "POST",
        headers: { Authorization: "Bearer {{cred:github}}", Accept: "application/vnd.github+json" },
        body: { title: "Storm: Release watch failed", body: "github.com answered 503\n\nRun r-1", labels: ["storm"] },
      });
      await db.client.proposal.update({
        where: { proposalId: proposal.proposalId },
        data: { status: "APPROVED", finalPayload: payload as Prisma.InputJsonValue, payloadHash: payloadHash(payload) },
      });
      expect(await runner.advance(runId)).toBe("DONE");
      expect(api.requests).toHaveLength(1);
      expect(JSON.stringify(await db.client.step.findMany({ where: { runId } }))).not.toContain(KEY);
    });
  });
});

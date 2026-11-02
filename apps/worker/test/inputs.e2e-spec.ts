import { createPrismaConnection, type PrismaConnection } from "@ai-me/db";
import { defaultCatalog, PipelineCompiler } from "@ai-me/steps";
import { TestEnvironment } from "@ai-me/testing";
import { createServer, type Server } from "node:http";
import { type AddressInfo, BlockList } from "node:net";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry, NO_ATTENTION, type StepContext } from "../src/runner/step-executor";
import { SaveStep } from "../src/steps/data-steps";
import { HistoryStep } from "../src/steps/history-step";
import { HttpFetchStep, type HttpFetchOptions } from "../src/steps/http-steps";
import { Counting, createVersion } from "./support/test-steps";

const entry = (id: number, title: string) =>
  `<entry><id>tag:github.com,2008:Release/${id}</id><title>${title}</title><updated>2026-10-${10 + id}T10:00:00Z</updated>` +
  `<link rel="alternate" type="text/html" href="https://github.com/acme/app/releases/tag/v${id}"/><content type="html">&lt;p&gt;Notes ${id}&lt;/p&gt;</content></entry>`;

/** M13 fixtures: a GitHub-like releases feed (with an ETag), an RSS feed, JSON, a page, redirects. */
class Feeds {
  requests: { path: string; ifNoneMatch?: string }[] = [];
  entries = [entry(1, "v1.0.0"), entry(2, "v2.0.0")];
  version = 1;
  private server!: Server;
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const path = req.url ?? "/";
      this.requests.push({ path, ifNoneMatch: req.headers["if-none-match"] });
      const etag = `"v${this.version}"`;
      if (path === "/releases.atom") {
        if (req.headers["if-none-match"] === etag) return res.writeHead(304, { etag }).end();
        return res
          .writeHead(200, { "content-type": "application/atom+xml; charset=utf-8", etag })
          .end(`<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Release notes from app</title>${this.entries.join("")}</feed>`);
      }
      if (path === "/news.rss")
        return res
          .writeHead(200, { "content-type": "application/rss+xml" })
          .end(
            `<rss version="2.0"><channel><title>News</title><item><title>PostgreSQL 18.1 released</title><link>https://example.org/18.1</link>` +
              `<pubDate>Thu, 13 Nov 2026 12:00:00 GMT</pubDate><description><![CDATA[<p>Security fixes</p>]]></description><guid>pg-18.1</guid></item></channel></rss>`,
          );
      if (path === "/api.json")
        return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { items: [{ id: 1, price: "1 299,00 лв." }] } }));
      if (path === "/big.json") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: "x".repeat(4000) }));
      if (path === "/page") return res.writeHead(200, { "content-type": "text/html" }).end("<title>Status</title><p>All systems normal</p>");
      if (path === "/to-metadata") return res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
      if (path === "/to-elsewhere") return res.writeHead(302, { location: "http://evil.test/collect" }).end();
      if (path === "/to-page") return res.writeHead(301, { location: "/page" }).end();
      res.writeHead(404).end();
    });
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", done));
    this.port = (this.server.address() as AddressInfo).port;
  }

  url(path: string, host = "feeds.test"): string {
    return `http://${host}:${this.port}${path}`;
  }

  stop(): Promise<void> {
    return new Promise((done) => this.server.close(() => done()));
  }
}

const DNS: Record<string, { address: string; family: number }[]> = {
  "feeds.test": [{ address: "127.0.0.1", family: 4 }],
  "inner.test": [{ address: "10.0.0.5", family: 4 }],
  "mixed.test": [
    { address: "140.82.112.3", family: 4 },
    { address: "192.168.1.1", family: 4 },
  ],
  "tailnet.test": [{ address: "100.101.102.103", family: 4 }],
};
const resolve: HttpFetchOptions["resolve"] = (host) =>
  DNS[host] ? Promise.resolve(DNS[host]) : Promise.reject(new Error(`getaddrinfo ENOTFOUND ${host}`));

/** The private ranges, but with 127.0.0.1 reachable: the local fixture server stands in for a public site. */
function exceptLoopback(): BlockList {
  const list = new BlockList();
  list.addSubnet("10.0.0.0", 8, "ipv4");
  list.addSubnet("100.64.0.0", 10, "ipv4");
  list.addSubnet("169.254.0.0", 16, "ipv4");
  list.addSubnet("192.168.0.0", 16, "ipv4");
  return list;
}

describe("M13: inputs without a browser and change detection", () => {
  let db: PrismaConnection;
  let userId: string;
  let feeds: Feeds;
  let fetchStep: HttpFetchStep;
  let telegram: Counting;
  let runner: PipelineRunner;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    feeds = new Feeds();
    await feeds.start();
  });

  beforeEach(() => {
    feeds.requests = [];
    feeds.entries = [entry(1, "v1.0.0"), entry(2, "v2.0.0")];
    feeds.version = 1;
    fetchStep = new HttpFetchStep(db.client, { blocked: exceptLoopback(), resolve });
    telegram = new Counting("notify.telegram", () => ({ sent: true }));
    runner = new PipelineRunner(db.client, catalogFor(), new ExecutorRegistry([fetchStep, new SaveStep(db.client), new HistoryStep(db.client), telegram]));
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.dataRecord.deleteMany();
    await db.client.dataPoint.deleteMany();
    await db.client.httpCache.deleteMany();
  });

  afterAll(async () => {
    await feeds.stop();
    await db.close();
  });

  const context = (allowedDomains: string[] = ["feeds.test"], dryRun = false): StepContext => ({
    runId: "00000000-0000-4000-8000-000000000001",
    userId,
    pipelineId: "00000000-0000-4000-8000-000000000002",
    stepId: "s",
    stepKey: "k",
    itemIndex: null,
    dryRun,
    recordUsage: () => undefined,
    attention: NO_ATTENTION,
    allowedDomains,
  });

  const fetchInput = (raw: Record<string, unknown>) => catalogFor().get("http.fetch")!.input.parse(raw);

  describe("M13-I1: http.fetch", () => {
    it("reads Atom, RSS, JSON and pages into items, json and text", async () => {
      const atom = (await fetchStep.execute(fetchInput({ url: feeds.url("/releases.atom") }), context())) as { items: Record<string, unknown>[]; documents: unknown[] };
      expect(atom.items).toEqual([
        {
          title: "v1.0.0",
          url: "https://github.com/acme/app/releases/tag/v1",
          published: "2026-10-11T10:00:00Z",
          summary: "Notes 1",
          id: "tag:github.com,2008:Release/1",
          source: feeds.url("/releases.atom"),
        },
        expect.objectContaining({ title: "v2.0.0", id: "tag:github.com,2008:Release/2" }),
      ]);
      expect(atom.documents).toEqual([
        { url: feeds.url("/releases.atom"), status: 200, notModified: false, contentType: "application/atom+xml", title: "Release notes from app", truncated: false },
      ]);

      const rss = (await fetchStep.execute(fetchInput({ urls: [feeds.url("/news.rss")] }), context())) as { items: unknown[] };
      expect(rss.items).toEqual([
        { title: "PostgreSQL 18.1 released", url: "https://example.org/18.1", published: "Thu, 13 Nov 2026 12:00:00 GMT", summary: "Security fixes", id: "pg-18.1", source: feeds.url("/news.rss") },
      ]);

      const json = (await fetchStep.execute(fetchInput({ url: feeds.url("/api.json"), itemsAt: "data.items" }), context())) as { items: unknown[]; json: unknown };
      expect(json.items).toEqual([{ id: 1, price: "1 299,00 лв.", source: feeds.url("/api.json") }]);
      expect(json.json).toEqual({ data: { items: [{ id: 1, price: "1 299,00 лв." }] } });

      const page = (await fetchStep.execute(fetchInput({ url: feeds.url("/to-page") }), context())) as { text: string; documents: { title: string }[] };
      expect(page.text).toBe("Status All systems normal");
      expect(page.documents[0].title).toBe("Status");
    });

    it("asks with the ETag the second time and reuses what it read on 304", async () => {
      const first = (await fetchStep.execute(fetchInput({ url: feeds.url("/releases.atom") }), context())) as { items: unknown };
      const second = (await fetchStep.execute(fetchInput({ url: feeds.url("/releases.atom") }), context())) as { items: unknown; documents: { notModified: boolean; status: number }[] };
      expect(feeds.requests.map((r) => r.ifNoneMatch)).toEqual([undefined, '"v1"']);
      expect(second.documents[0]).toMatchObject({ status: 304, notModified: true });
      expect(second.items).toEqual(first.items);
    });

    it("refuses JSON over maxKb", async () => {
      await expect(fetchStep.execute(fetchInput({ url: feeds.url("/big.json"), maxKb: 1 }), context())).rejects.toThrow("the JSON is larger than maxKb");
    });

    it("feed → data.save → a message only when something is new (when:)", async () => {
      const versionId = await createVersion(db.client, userId, RELEASES(feeds.url("/releases.atom")), compilerFor());
      const told = () => telegram.calls.filter((c) => String(c.text).startsWith("New releases"));
      const first = await runner.start(versionId, { trigger: "manual" });
      expect(await runner.advance(first)).toBe("DONE");
      expect(told()).toHaveLength(1);
      expect(String(told()[0].text)).toContain("v1.0.0");

      // Unchanged (304): nothing new, no message.
      const second = await runner.start(versionId, { trigger: "manual" });
      expect(await runner.advance(second)).toBe("DONE");
      expect(told()).toHaveLength(1);
      expect(await db.client.step.findFirstOrThrow({ where: { runId: second, stepKey: "tell" } })).toMatchObject({
        status: "SKIPPED",
        error: "Skipped: {{save.added}} is empty",
      });
      expect(await db.client.step.findFirstOrThrow({ where: { runId: second, stepKey: "summary" } })).toMatchObject({
        status: "SKIPPED",
        error: "Skipped: it uses tell, which was skipped",
      });

      // A new release and a renamed one.
      feeds.version = 2;
      feeds.entries = [entry(1, "v1.0.1"), entry(2, "v2.0.0"), entry(3, "v3.0.0")];
      const third = await runner.start(versionId, { trigger: "manual" });
      expect(await runner.advance(third)).toBe("DONE");
      expect(told()).toHaveLength(2);
      const save = (await db.client.step.findFirstOrThrow({ where: { runId: third, stepKey: "save" } })).output as { added: { title: string }[]; changed: unknown[] };
      expect(save.added.map((a) => a.title)).toEqual(["v3.0.0"]);
      expect(save.changed).toEqual([
        { key: "tag:github.com,2008:Release/1", item: expect.objectContaining({ title: "v1.0.1" }) as unknown, before: { title: "v1.0.0" }, after: { title: "v1.0.1" } },
      ]);
    });
  });

  describe("M13-S1: only allowed hosts, never private or tailnet addresses", () => {
    const strict = () => new HttpFetchStep(db.client, { resolve });
    const refused = (step: HttpFetchStep, url: string, allowed: string[]) => step.execute(fetchInput({ url }), context(allowed));

    it("refuses a host outside the policy, and every private, local, link-local or tailnet address", async () => {
      await expect(refused(strict(), feeds.url("/page", "other.test"), ["feeds.test"])).rejects.toThrow("other.test isn't in the pipeline's allowedDomains");
      await expect(refused(strict(), feeds.url("/page"), ["feeds.test"])).rejects.toThrow("feeds.test resolves to a private or local address (127.0.0.1)");
      await expect(refused(strict(), "http://inner.test/", ["inner.test"])).rejects.toThrow("resolves to a private or local address (10.0.0.5)");
      await expect(refused(strict(), "http://tailnet.test/", ["tailnet.test"])).rejects.toThrow("(100.101.102.103)");
      await expect(refused(strict(), "http://mixed.test/", ["mixed.test"])).rejects.toThrow("(192.168.1.1)");
      await expect(refused(strict(), `http://127.0.0.1:${feeds.port}/page`, ["127.0.0.1"])).rejects.toThrow("127.0.0.1 is a private or local address");
      await expect(refused(strict(), `http://[::1]:${feeds.port}/page`, ["::1"])).rejects.toThrow("::1 is a private or local address");
      await expect(refused(strict(), `http://[::ffff:127.0.0.1]:${feeds.port}/page`, ["::ffff:7f00:1"])).rejects.toThrow("is a private or local address");
      await expect(refused(strict(), "file:///etc/passwd", ["feeds.test"])).rejects.toThrow();
      expect(feeds.requests).toEqual([]);
    });

    it("checks every redirect: to cloud metadata, or to a host outside the policy", async () => {
      await expect(refused(fetchStep, feeds.url("/to-metadata"), ["feeds.test", "169.254.169.254"])).rejects.toThrow("169.254.169.254 is a private or local address");
      await expect(refused(fetchStep, feeds.url("/to-elsewhere"), ["feeds.test"])).rejects.toThrow("evil.test isn't in the pipeline's allowedDomains");
      expect(feeds.requests.map((r) => r.path)).toEqual(["/to-metadata", "/to-elsewhere"]);
    });
  });

  describe("M13-I2: data.save into a collection", () => {
    const run = (items: object[], extra: object = {}, dryRun = false) =>
      new SaveStep(db.client).execute(
        catalogFor().get("data.save")!.input.parse({ items, collection: "prices", key: "url", ...extra }),
        context(undefined, dryRun),
      ) as Promise<{ added: unknown[]; changed: unknown[]; removed: unknown[]; created: number; skipped: number }>;

    it("reports added, changed (only the named fields, before and after) and, for a complete list, removed", async () => {
      const a = { url: "https://shop.test/a", name: "WD Purple 8TB", price: 399, seenAt: "mon" };
      const b = { url: "https://shop.test/b", name: "Seagate SkyHawk 8TB", price: 379, seenAt: "mon" };
      const first = await run([a, b, { name: "no url" }], { fields: ["price", "name"], complete: true });
      expect(first).toMatchObject({ created: 2, skipped: 1, changed: [], removed: [] });
      expect(first.added).toEqual([a, b]);

      const second = await run([{ ...a, price: 349, seenAt: "tue" }, { url: "https://shop.test/c", name: "Toshiba S300 8TB", price: 359 }], {
        fields: ["price", "name"],
        complete: true,
      });
      expect(second.added).toEqual([expect.objectContaining({ url: "https://shop.test/c" })]);
      expect(second.changed).toEqual([{ key: "https://shop.test/a", item: { ...a, price: 349, seenAt: "tue" }, before: { price: 399 }, after: { price: 349 } }]);
      expect(second.removed).toEqual([b]);

      // b is back: added again. Not complete: nothing is removed.
      const third = await run([b], { fields: ["price", "name"] });
      expect(third).toMatchObject({ added: [b], changed: [], removed: [] });
    });

    it("saves nothing in a dry run", async () => {
      await run([{ url: "https://shop.test/a", price: 1 }], {}, true);
      expect(await db.client.dataRecord.count()).toBe(0);
    });

    it("leaves my marks (M27) as they are, through a change, a removal and a return", async () => {
      const a = { url: "https://shop.test/a", price: 1 };
      await run([a]);
      await db.client.dataRecord.updateMany({ data: { marks: { done: "2026-11-02T10:00:00.000Z" } } });
      await run([{ ...a, price: 2 }]);
      await run([{ url: "https://shop.test/b", price: 3 }], { complete: true });
      await run([a]);
      const saved = await db.client.dataRecord.findFirstOrThrow({ where: { key: a.url } });
      expect([saved.value, saved.marks, saved.removedAt]).toEqual([a, { done: "2026-11-02T10:00:00.000Z" }, null]);
    });
  });

  describe("M13-I3: data.history", () => {
    const record = (price: unknown, keep = 60) =>
      new HistoryStep(db.client).execute(
        catalogFor().get("data.history")!.input.parse({ items: [{ url: "https://shop.test/a", price }], collection: "prices", key: "url", value: "price", keep }),
        context(),
      ) as Promise<{ items: { history: Record<string, unknown> | null }[]; recorded: number; unreadable: number }>;

    it("keeps the series per key and reports the trend", async () => {
      expect((await record("399,00 лв.")).items[0].history).toEqual({ value: 399, previous: null, change: null, changePct: null, min: 399, max: 399, count: 1, direction: "new", lowest: false });
      expect((await record("419,00 лв.")).items[0].history).toMatchObject({ previous: 399, change: 20, direction: "up", lowest: false, max: 419 });
      expect((await record("349,90 лв.")).items[0].history).toEqual({
        value: 349.9,
        previous: 419,
        change: -69.1,
        changePct: -16.49,
        min: 349.9,
        max: 419,
        count: 3,
        direction: "down",
        lowest: true,
      });
      const unreadable = await record("out of stock");
      expect(unreadable).toMatchObject({ recorded: 0, unreadable: 1, items: [{ history: null }] });
      expect(await db.client.dataPoint.count()).toBe(3);

      await record(350, 2);
      expect((await db.client.dataPoint.findMany({ orderBy: { at: "asc" } })).map((p) => p.value)).toEqual([349.9, 350]);
    });
  });
});

const RELEASES = (url: string) => `
name: Releases
policy: { allowedDomains: [feeds.test] }
steps:
  - id: fetch
    type: http.fetch
    with: { url: "${url}" }
  - id: save
    type: data.save
    with: { items: "{{fetch.items}}", collection: releases, key: id, fields: [title] }
  - id: tell
    type: notify.telegram
    when: "{{save.added}}"
    with: { text: "New releases: {{save.added}}" }
  - id: summary
    type: notify.telegram
    with: { text: "Sent: {{tell.sent}}" }
`;

const catalogFor = () => defaultCatalog();
const compilerFor = () => new PipelineCompiler(defaultCatalog());

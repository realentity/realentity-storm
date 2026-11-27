import { exampleYaml } from "@realentity/storm-shared/example-files";
import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { ModelRouter, type LlmClient } from "@realentity/storm-llm";
import { readAppSource } from "@realentity/storm-shared";
import { defaultCatalog, PipelineCompiler } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { createServer, type Server } from "node:http";
import { type AddressInfo, BlockList } from "node:net";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry } from "../src/runner/step-executor";
import { FilterStep, SaveStep } from "../src/steps/data-steps";
import { ReadStep } from "../src/steps/entity-steps";
import { HistoryStep } from "../src/steps/history-step";
import { type HttpFetchOptions } from "../src/steps/http-steps";
import { AlertStep, MapStep } from "../src/steps/map-alert-steps";
import { ProductStep } from "../src/steps/product-step";
import { Counting, createVersion } from "./support/test-steps";

jest.setTimeout(60_000);

/** Shops on one local server, told apart by host: each page's price and stock can change between runs. */
class Shops {
  readonly pages = new Map<string, { price: number; inStock: boolean }>();
  readonly requested: string[] = [];
  private server!: Server;
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const address = `${(req.headers.host ?? "").split(":")[0]}${req.url ?? ""}`;
      this.requested.push(address);
      const page = this.pages.get(address);
      if (!page) return res.writeHead(404).end();
      const data = {
        "@context": "https://schema.org/",
        "@type": "Product",
        name: "Skogsö Padded Jacket",
        offers: { "@type": "Offer", price: page.price, priceCurrency: "EUR", availability: `https://schema.org/${page.inStock ? "InStock" : "OutOfStock"}` },
      };
      res.writeHead(200, { "content-type": "text/html" }).end(`<html><head><script type="application/ld+json">${JSON.stringify(data)}</script></head></html>`);
    });
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", done));
    this.port = (this.server.address() as AddressInfo).port;
  }

  url(host: string, path: string): string {
    return `http://${host}:${this.port}${path}`;
  }

  set(host: string, path: string, price: number, inStock = true): void {
    this.pages.set(`${host}${path}`, { price, inStock });
  }

  stop(): Promise<void> {
    return new Promise((done) => this.server.close(() => done()));
  }
}

const resolve: HttpFetchOptions["resolve"] = (host) =>
  host.endsWith(".localhost") ? Promise.resolve([{ address: "127.0.0.1", family: 4 }]) : Promise.reject(new Error(`getaddrinfo ENOTFOUND ${host}`));
const blocked = new BlockList();
blocked.addSubnet("10.0.0.0", 8, "ipv4");

const NO_LLM: LlmClient = { structured: () => Promise.reject(new Error("no LLM in this test")) };

// M24, M33; M71: the Prices App on generic steps only (data.read, shop.product, data.map, data.save, data.history, data.alert)
describe("examples/apps/prices.yaml", () => {
  const source = exampleYaml("apps/prices.yaml");
  const app = readAppSource(source);
  const compiler = new PipelineCompiler(defaultCatalog());
  let db: PrismaConnection;
  let userId: string;
  let appId: string;
  let shops: Shops;
  let telegram: Counting;
  let runner: PipelineRunner;
  let versionId: string;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    shops = new Shops();
    await shops.start();
  });

  beforeEach(async () => {
    shops.pages.clear();
    shops.requested.length = 0;
    const created = await db.client.app.create({ data: { userId, name: "Prices" } });
    const version = await db.client.appVersion.create({ data: { appId: created.appId, version: 1, definition: {}, source } });
    await db.client.app.update({ where: { appId: created.appId }, data: { currentVersionId: version.appVersionId } });
    appId = created.appId;
    telegram = new Counting("notify.telegram", () => ({ sent: true }));
    runner = new PipelineRunner(
      db.client,
      defaultCatalog(),
      new ExecutorRegistry([
        new ReadStep(db.client),
        new MapStep(),
        new ProductStep(NO_LLM, new ModelRouter(() => Promise.resolve(null)), { blocked, resolve }),
        new SaveStep(db.client),
        new FilterStep(),
        new HistoryStep(db.client),
        new AlertStep(db.client),
        telegram,
      ]),
    );
    versionId = await createVersion(db.client, userId, exampleYaml("prices"), compiler, { app });
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.app.deleteMany();
    await db.client.dataPoint.deleteMany();
  });

  afterAll(async () => {
    await shops.stop();
    await db.close();
  });

  /** A Product of the user's, as its form keeps it: the name is its key, the rest `mine`. */
  const product = (name: string, fields: { targetPrice?: number; currency?: string; enabled?: boolean } = {}) =>
    db.client.dataEntity.create({ data: { appId, type: "Product", key: name, value: { name }, mine: fields } });
  const shop = (name: string, productName: string, url: string, variant?: string) =>
    db.client.dataEntity.create({ data: { appId, type: "Shop", key: name, value: { name }, mine: { product: productName, url, ...(variant ? { variant } : {}) } } });
  const offers = () => db.client.dataEntity.findMany({ where: { appId, type: "Offer" }, orderBy: { key: "asc" } });
  /** A run to its end; what it told on Telegram. */
  const check = async (dryRun = false): Promise<string[]> => {
    const before = telegram.calls.length;
    const runId = await runner.start(versionId, { trigger: "manual", dryRun });
    const status = await runner.advance(runId);
    if (status !== "DONE") {
      const failed = await db.client.step.findMany({ where: { runId, error: { not: null } }, select: { stepKey: true, error: true } });
      throw new Error(`${status}: ${failed.map((f) => `${f.stepKey}: ${f.error}`).join("\n")}`);
    }
    return telegram.calls.slice(before).map((c) => c.text as string);
  };

  it("tells only news: a new low, crossing the target once, back in stock; names the cheapest shop; nothing when nothing changed", async () => {
    shops.set("one.localhost", "/jacket", 320);
    shops.set("two.localhost", "/p/7", 330);
    await product("Jacket", { targetPrice: 300, currency: "EUR" });
    await shop("Jacket at one", "Jacket", shops.url("one.localhost", "/jacket"));
    await shop("Jacket at two", "Jacket", shops.url("two.localhost", "/p/7"));

    // The first look: nothing to compare with, and a dry run keeps nothing.
    expect(await check(true)).toEqual([]);
    expect([await db.client.dataPoint.count(), (await offers()).length]).toEqual([0, 0]);
    expect(await check()).toEqual([]);
    expect(await db.client.dataPoint.count()).toBe(2);
    // An Offer per shop, keyed by the product and the address; the addresses are mine, so no allowedDomains.
    expect((await offers()).map((o) => [o.key, o.value])).toEqual([
      [`Jacket | ${shops.url("one.localhost", "/jacket")}`, expect.objectContaining({ product: "Jacket", shop: `one.localhost`, price: 320, currency: "EUR", inStock: true })],
      [`Jacket | ${shops.url("two.localhost", "/p/7")}`, expect.objectContaining({ price: 330 })],
    ]);

    // Shop one lower than ever.
    shops.set("one.localhost", "/jacket", 310);
    expect(await check()).toEqual([`Prices:\nJacket: 310.00 EUR at one.localhost, the lowest in 90 days\n${shops.url("one.localhost", "/jacket")}`]);

    // Shop two crosses the target: told with what makes it news; it is the cheapest now, so no other shop is named.
    shops.set("two.localhost", "/p/7", 299);
    expect(await check()).toEqual([
      `Prices:\nJacket: 299.00 EUR at two.localhost, at or under your target 300.00 EUR, the lowest in 90 days\n${shops.url("two.localhost", "/p/7")}`,
    ]);

    // Unchanged, or still under the target: nothing.
    expect(await check()).toEqual([]);

    // Sold out at two: nothing new; back in stock at two is news.
    shops.set("two.localhost", "/p/7", 299, false);
    expect(await check()).toEqual([]);
    shops.set("one.localhost", "/jacket", 304);
    shops.set("two.localhost", "/p/7", 305);
    expect(await check()).toEqual([
      `Prices:\nJacket: 304.00 EUR at one.localhost, the lowest in 90 days\n${shops.url("one.localhost", "/jacket")}\n` +
        `Jacket: 305.00 EUR at two.localhost, back in stock (cheapest now: 304.00 EUR at one.localhost)\n${shops.url("two.localhost", "/p/7")}`,
    ]);

    // A shop the user removed: its Offer goes.
    await db.client.dataEntity.deleteMany({ where: { appId, type: "Shop", key: "Jacket at two" } });
    await check();
    expect((await offers()).map((o) => o.removedAt === null)).toEqual([true, false]);
  });

  it("a shop's variant goes to shop.product; a page it can't read keeps the last price, with the problem, and is told; a paused product isn't read", async () => {
    shops.set("one.localhost", "/kettle", 49.9);
    shops.set("one.localhost", "/jacket", 320);
    await product("Kettle");
    await product("Jacket");
    await product("Paused", { enabled: false });
    await shop("Kettle at one", "Kettle", shops.url("one.localhost", "/kettle"));
    await shop("Jacket M", "Jacket", shops.url("one.localhost", "/jacket"), "size: M, color: Black");
    await shop("Paused at one", "Paused", shops.url("one.localhost", "/x"));
    await check();
    expect(shops.requested).not.toContain("one.localhost/x");

    // The page has no variants: the one asked for is a problem, with no price before it.
    const jacket = await db.client.dataEntity.findFirstOrThrow({ where: { appId, type: "Offer", key: `Jacket | ${shops.url("one.localhost", "/jacket")} | size: M, color: Black` } });
    expect(jacket.value).toMatchObject({ variant: "size: M, color: Black", problem: expect.stringMatching(/no variant with size M, color Black/) as string });
    expect(jacket.value).not.toHaveProperty("price");

    // The kettle's page gone: its last price stays, with why.
    shops.pages.delete("one.localhost/kettle");
    const told = await check();
    expect(told).toEqual([
      "Prices: can't read Jacket at one.localhost: no variant with size M, color Black (the variants have no size; the variants have no color); " +
        "Kettle at one.localhost: the page is gone (404)",
    ]);
    const kettle = await db.client.dataEntity.findFirstOrThrow({ where: { appId, type: "Offer", key: `Kettle | ${shops.url("one.localhost", "/kettle")}` } });
    expect(kettle.value).toMatchObject({ price: 49.9, problem: "the page is gone (404)" });
  });

  it("a variant that isn't attribute: value is that shop's problem, not a failed run", async () => {
    shops.set("one.localhost", "/jacket", 320);
    await product("Jacket");
    await shop("Jacket", "Jacket", shops.url("one.localhost", "/jacket"), "medium");
    expect(await check()).toEqual([expect.stringContaining('"medium" isn\'t a variant')]);
  });
});

import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { ModelRouter, type LlmClient } from "@realentity/storm-llm";
import { TestEnvironment } from "@realentity/storm-testing";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { type AddressInfo, BlockList } from "node:net";
import { NO_ATTENTION, type StepContext } from "../src/runner/step-executor";
import { type HttpFetchOptions } from "../src/steps/http-steps";
import { PriceWatchStep } from "../src/steps/price-steps";
import { ProductStep } from "../src/steps/product-step";

/** Two shops on one local server, told apart by host: each page's price and stock can change between runs. */
class Shops {
  readonly pages = new Map<string, { price: number; inStock: boolean }>();
  private server!: Server;
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const page = this.pages.get(`${(req.headers.host ?? "").split(":")[0]}${req.url ?? ""}`);
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

/** The Prices App price.watch reads Products from and writes Offers into (M33). */
const PRICES_APP = readFileSync(join(__dirname, "../../../pipelines/apps/prices.yaml"), "utf8");

// M24, M33
describe("price.watch", () => {
  let db: PrismaConnection;
  let userId: string;
  let shops: Shops;
  let step: PriceWatchStep;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    shops = new Shops();
    await shops.start();
    const product = new ProductStep(NO_LLM, new ModelRouter(() => Promise.resolve(null)), { blocked, resolve });
    step = new PriceWatchStep(db.client, product);
  });

  let appId: string;

  beforeEach(async () => {
    const app = await db.client.app.create({ data: { userId, name: "Prices" } });
    const version = await db.client.appVersion.create({ data: { appId: app.appId, version: 1, definition: {}, source: PRICES_APP } });
    await db.client.app.update({ where: { appId: app.appId }, data: { currentVersionId: version.appVersionId } });
    appId = app.appId;
  });

  afterEach(async () => {
    await db.client.app.deleteMany();
    await db.client.dataPoint.deleteMany();
  });

  /** A Product of the user's, as its form keeps it: the name is its key, the rest `mine`. */
  const product = (name: string, fields: { targetPrice?: number; currency?: string; enabled?: boolean; shops: string[] }) =>
    db.client.dataEntity.create({ data: { appId, type: "Product", key: name, value: { name }, mine: fields } });
  const offers = () => db.client.dataEntity.findMany({ where: { appId, type: "Offer" }, orderBy: { key: "asc" } });

  afterAll(async () => {
    await shops.stop();
    await db.close();
  });

  const context = (dryRun = false): StepContext => ({
    runId: randomUUID(),
    userId,
    pipelineId: randomUUID(),
    stepId: "s",
    stepKey: "watch",
    itemIndex: null,
    dryRun,
    app: "Prices",
    recordUsage: () => undefined,
    attention: NO_ATTENTION,
    allowedDomains: [],
  });
  const watch = async (dryRun = false) =>
    (await step.execute({ lowestDays: 90 }, context(dryRun))) as {
      products: { name: string; cheapest: { shop: string; price: number } | null }[];
      news: { shop: string; why: string[] }[];
      text: string;
      problems: string[];
    };

  // M24-I1
  it("tells only news: a new low, crossing the target once, back in stock; names the cheapest shop; nothing when nothing changed", async () => {
    shops.set("one.localhost", "/jacket", 320);
    shops.set("two.localhost", "/p/7", 330);
    await product("Jacket", { targetPrice: 300, currency: "EUR", shops: [shops.url("one.localhost", "/jacket"), shops.url("two.localhost", "/p/7")] });

    // The first look: nothing to compare with, and a dry run keeps nothing.
    expect((await watch(true)).text).toBe("");
    expect(await db.client.dataPoint.count()).toBe(0);
    const first = await watch();
    expect(first.news).toEqual([]);
    expect(first.products[0]?.cheapest).toMatchObject({ shop: "one.localhost", price: 320 });
    expect(await db.client.dataPoint.count()).toBe(2);
    // M33: an Offer per shop line, keyed by the product and the address.
    expect((await offers()).map((o) => [o.key, o.value])).toEqual([
      [`Jacket | ${shops.url("one.localhost", "/jacket")}`, expect.objectContaining({ product: "Jacket", shop: "one.localhost", price: 320, currency: "EUR", inStock: true })],
      [`Jacket | ${shops.url("two.localhost", "/p/7")}`, expect.objectContaining({ shop: "two.localhost", price: 330 })],
    ]);

    // Shop one lower than ever.
    shops.set("one.localhost", "/jacket", 310);
    expect((await watch()).text).toBe(`Prices:\nJacket: 310.00 EUR at one.localhost, the lowest in 90 days\n${shops.url("one.localhost", "/jacket")}`);

    // Shop two crosses the target: told with what makes it news; it is the cheapest now.
    shops.set("two.localhost", "/p/7", 299);
    const crossed = await watch();
    expect(crossed.news.map((n) => [n.shop, n.why])).toEqual([["two.localhost", ["at or under your target 300.00 EUR", "the lowest in 90 days"]]]);
    expect(crossed.products[0]?.cheapest).toMatchObject({ shop: "two.localhost", price: 299 });

    // Unchanged, or still under the target: nothing.
    expect((await watch()).text).toBe("");

    // Sold out at two: shop one is the cheapest again; back in stock at two is news, and shop one is named.
    shops.set("two.localhost", "/p/7", 299, false);
    const soldOut = await watch();
    expect([soldOut.text, soldOut.products[0]?.cheapest?.shop]).toEqual(["", "one.localhost"]);
    shops.set("two.localhost", "/p/7", 305);
    expect((await watch()).text).toBe(
      `Prices:\nJacket: 305.00 EUR at two.localhost, back in stock\n${shops.url("two.localhost", "/p/7")}`,
    );

    // A shop line the user removed: its Offer goes.
    await db.client.dataEntity.updateMany({ where: { appId, type: "Product" }, data: { mine: { targetPrice: 300, currency: "EUR", shops: [shops.url("one.localhost", "/jacket")] } } });
    await watch();
    expect((await offers()).map((o) => o.removedAt === null)).toEqual([true, false]);
  });

  it("reads a variant from the shop line, and refuses a line that isn't an address", async () => {
    shops.set("one.localhost", "/jacket", 320);
    await product("Jacket", { shops: [`${shops.url("one.localhost", "/jacket")} | size: M, color: Black`, "not a shop"] });
    const result = await watch();
    // The variant goes to shop.product with the address: this page has none, so it says so.
    expect(result.problems).toEqual([
      'Jacket: "not a shop" isn\'t an address (https://…, then "| size: M" for a variant)',
      expect.stringMatching(/^Jacket at one\.localhost: .*no variant with size M, color Black/),
    ]);
    expect((await offers()).map((o) => [o.key, (o.value as { variant?: string }).variant])).toEqual([
      [`Jacket | ${shops.url("one.localhost", "/jacket")} | size: M, color: Black`, "size: M, color: Black"],
    ]);
  });

  it("a page it can't read is a problem, not a failure; a paused product isn't checked", async () => {
    shops.set("one.localhost", "/kettle", 49.9);
    await product("Kettle", { shops: [shops.url("one.localhost", "/kettle"), shops.url("one.localhost", "/gone")] });
    await product("Paused", { enabled: false, shops: [shops.url("one.localhost", "/x")] });

    const result = await watch();
    expect(result.products.map((p) => p.name)).toEqual(["Kettle"]);
    expect(result.problems).toEqual([expect.stringMatching(/^Kettle at one\.localhost: /)]);
    const gone = await db.client.dataEntity.findFirstOrThrow({ where: { appId, key: `Kettle | ${shops.url("one.localhost", "/gone")}` } });
    expect(gone.value).toMatchObject({ problem: expect.any(String) as string });
    expect(gone.value).not.toHaveProperty("price");
  });
});

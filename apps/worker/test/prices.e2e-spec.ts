import { createPrismaConnection, type PrismaConnection } from "@ai-me/db";
import { ModelRouter, type LlmClient } from "@ai-me/llm";
import { TestEnvironment } from "@ai-me/testing";
import { randomUUID } from "node:crypto";
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

// M24
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

  afterEach(async () => {
    await db.client.watchedProduct.deleteMany();
    await db.client.dataPoint.deleteMany();
  });

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
    await db.client.watchedProduct.create({
      data: {
        userId,
        name: "Jacket",
        targetPrice: 300,
        currency: "EUR",
        offers: { create: [{ url: shops.url("one.localhost", "/jacket") }, { url: shops.url("two.localhost", "/p/7") }] },
      },
    });

    // The first look: nothing to compare with, and a dry run keeps nothing.
    expect((await watch(true)).text).toBe("");
    expect(await db.client.dataPoint.count()).toBe(0);
    const first = await watch();
    expect(first.news).toEqual([]);
    expect(first.products[0]?.cheapest).toMatchObject({ shop: "one.localhost", price: 320 });
    expect(await db.client.dataPoint.count()).toBe(2);

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
  });

  it("a page it can't read is a problem, not a failure; a paused product isn't checked", async () => {
    shops.set("one.localhost", "/kettle", 49.9);
    await db.client.watchedProduct.create({
      data: { userId, name: "Kettle", offers: { create: [{ url: shops.url("one.localhost", "/kettle") }, { url: shops.url("one.localhost", "/gone") }] } },
    });
    await db.client.watchedProduct.create({ data: { userId, name: "Paused", enabled: false, offers: { create: [{ url: shops.url("one.localhost", "/x") }] } } });

    const result = await watch();
    expect(result.products.map((p) => p.name)).toEqual(["Kettle"]);
    expect(result.problems).toEqual([expect.stringMatching(/^Kettle at one\.localhost: /)]);
    const gone = await db.client.watchedOffer.findFirstOrThrow({ where: { url: shops.url("one.localhost", "/gone") } });
    expect(gone).toMatchObject({ lastPrice: null, lastProblem: expect.any(String) as string });
  });
});

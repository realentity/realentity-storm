import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { emptyUsage, ModelRouter, type LlmClient, type StructuredRequest } from "@realentity/storm-llm";
import { defaultCatalog, PipelineCompiler } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { createServer, type Server } from "node:http";
import { type AddressInfo, BlockList } from "node:net";
import { type z } from "zod";
import { BrowserPool } from "../src/browser/browser-pool";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry, NO_ATTENTION, type StepContext } from "../src/runner/step-executor";
import { FilterStep } from "../src/steps/data-steps";
import { HistoryStep } from "../src/steps/history-step";
import { type HttpFetchOptions } from "../src/steps/http-steps";
import { ProductStep } from "../src/steps/product-step";
import { Counting, createVersion } from "./support/test-steps";

const productData = (price: number) =>
  JSON.stringify({
    "@context": "https://schema.org/",
    "@type": "ProductGroup",
    name: "Skogsö Padded Jacket",
    brand: { "@type": "Brand", name: "Fjällräven" },
    hasVariant: ["M", "L"].flatMap((size) =>
      ["Black", "Green"].map((color) => ({
        "@type": "Product",
        sku: `J-${color}-${size}`,
        color,
        size,
        offers: { "@type": "Offer", price: color === "Black" && size === "M" ? price : 400, priceCurrency: "EUR", availability: "https://schema.org/InStock" },
      })),
    ),
  });

/** A shop: a product page with schema.org data, one that turns away anything but a browser, one with only text. */
class Shop {
  price = 343.16;
  requests: { path: string; agent: string }[] = [];
  private server!: Server;
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const path = req.url ?? "/";
      const agent = req.headers["user-agent"] ?? "";
      this.requests.push({ path, agent });
      const html = (head: string, body = "") => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<html><head>${head}</head><body>${body}</body></html>`);
      if (path === "/p/jacket") return html(`<title>Jacket</title><script type="application/ld+json">${productData(this.price)}</script>`);
      if (path === "/p/guarded") {
        // A bot wall for plain HTTP; in the browser, the data is added by a script.
        if (!agent.includes("Chrome")) return res.writeHead(403).end("Forbidden");
        return html(
          "<title>Jacket</title>",
          `<script>const s = document.createElement("script"); s.type = "application/ld+json"; s.text = ${JSON.stringify(productData(this.price))}; document.head.append(s);</script>`,
        );
      }
      if (path === "/p/kettle") return html("<title>Kettle</title>", "<h1>Steel kettle</h1><p>Now € 49,99 (was € 59,99). In stock.</p>");
      if (path === "/p/moved") return res.writeHead(301, { location: "/p/jacket" }).end();
      if (path === "/p/away") return res.writeHead(302, { location: `http://elsewhere.localhost:${this.port}/p/jacket` }).end();
      res.writeHead(404).end();
    });
    await new Promise<void>((done) => this.server.listen(0, "127.0.0.1", done));
    this.port = (this.server.address() as AddressInfo).port;
  }

  url(path: string, host = "shop.localhost"): string {
    return `http://${host}:${this.port}${path}`;
  }

  stop(): Promise<void> {
    return new Promise((done) => this.server.close(() => done()));
  }
}

/** The cheap model reading a page's text: answers what it's given and keeps the prompts. */
class PageReader implements LlmClient {
  prompts: string[] = [];
  models: string[] = [];
  structured<S extends z.ZodObject>(request: StructuredRequest<S>) {
    this.prompts.push(request.prompt);
    this.models.push(request.choice.model);
    const answer = { found: true, title: "Steel kettle", price: 49.99, currency: "EUR", inStock: true, note: "the current price, not the crossed-out one" };
    return Promise.resolve({ output: request.schema.parse(answer), usage: { ...emptyUsage(), calls: 1, costUsd: 0.001 } });
  }
}

const DNS: Record<string, { address: string; family: number }[]> = {
  "shop.localhost": [{ address: "127.0.0.1", family: 4 }],
  "elsewhere.localhost": [{ address: "127.0.0.1", family: 4 }],
  "inner.localhost": [{ address: "10.0.0.5", family: 4 }],
};
const resolve: HttpFetchOptions["resolve"] = (host) =>
  DNS[host] ? Promise.resolve(DNS[host]) : Promise.reject(new Error(`getaddrinfo ENOTFOUND ${host}`));

/** The private ranges, but with 127.0.0.1 reachable: the local shop stands in for a public one. */
function exceptLoopback(): BlockList {
  const list = new BlockList();
  list.addSubnet("10.0.0.0", 8, "ipv4");
  list.addSubnet("169.254.0.0", 16, "ipv4");
  list.addSubnet("192.168.0.0", 16, "ipv4");
  return list;
}

const WATCH = (url: string) => `
name: Jacket watch
policy: { allowedDomains: [shop.localhost] }
steps:
  - id: product
    type: shop.product
    with:
      products: [{ url: "${url}", select: { size: M, color: Black } }]
  - id: prices
    type: data.history
    with: { items: "{{product.items}}", collection: prices, key: id, value: price }
  - id: cheaper
    type: data.filter
    with: { items: "{{prices.items}}", where: [{ field: history.direction, op: eq, value: down }] }
  - id: tell
    type: notify.telegram
    when: "{{cheaper.items}}"
    with: { text: "Cheaper: {{cheaper.items}}" }
  - id: trouble
    type: notify.telegram
    when: "{{product.problems}}"
    with: { text: "Can't read: {{product.problems}}" }
`;

// M13 follow-up: a product's price, or one variant's, from its page; the browser and the cheap model only when needed.
describe("shop.product: watching a product page", () => {
  let db: PrismaConnection;
  let userId: string;
  let shop: Shop;
  let pool: BrowserPool;
  let llm: PageReader;
  let step: ProductStep;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    shop = new Shop();
    await shop.start();
    pool = new BrowserPool();
  });

  beforeEach(() => {
    shop.requests = [];
    shop.price = 343.16;
    llm = new PageReader();
    step = new ProductStep(llm, new ModelRouter(async () => null), { blocked: exceptLoopback(), resolve }, pool);
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.dataPoint.deleteMany();
  });

  afterAll(async () => {
    await pool.close();
    await shop.stop();
    await db.close();
  });

  const context = (allowedDomains: string[] = ["shop.localhost"]): StepContext => ({
    runId: "00000000-0000-4000-8000-000000000001",
    userId,
    pipelineId: "00000000-0000-4000-8000-000000000002",
    stepId: "s",
    stepKey: "k",
    itemIndex: null,
    dryRun: false,
    recordUsage: () => undefined,
    attention: NO_ATTENTION,
    allowedDomains,
  });
  const read = (raw: Record<string, unknown>, allowed?: string[]) =>
    step.execute(defaultCatalog().get("shop.product")!.input.parse(raw), context(allowed)) as Promise<{ items: Record<string, unknown>[]; problems: string[] }>;

  it("reads the chosen variant from the page's schema.org data, without a browser or an LLM", async () => {
    const { items, problems } = await read({ url: shop.url("/p/jacket"), select: { size: "M", color: "Black" } });
    expect(items).toEqual([
      expect.objectContaining({
        id: `${shop.url("/p/jacket")}#color=Black&size=M`,
        title: "Skogsö Padded Jacket",
        brand: "Fjällräven",
        price: 343.16,
        currency: "EUR",
        inStock: true,
        variant: { color: "Black", size: "M" },
        source: "schema.org",
        problem: null,
      }),
    ]);
    expect(problems).toEqual([]);
    expect(shop.requests.map((r) => r.agent)).toEqual([expect.stringMatching(/^RealEntity-Storm\//)]);
    expect(llm.prompts).toHaveLength(0);
  });

  it("a page that turns plain requests away opens in the browser, which reads the data its scripts add", async () => {
    const { items } = await read({ url: shop.url("/p/guarded"), select: { size: "M", color: "Black" } });
    expect(items[0]).toMatchObject({ price: 343.16, source: "schema.org, in the browser", problem: null });
    expect(shop.requests.filter((r) => r.path === "/p/guarded").map((r) => r.agent.includes("Chrome"))).toEqual([false, true]);
    expect(llm.prompts).toHaveLength(0);
    // browser: never stops at the wall, and says so.
    await expect(read({ url: shop.url("/p/guarded"), browser: "never" })).rejects.toThrow("the site answered 403 (browser: never)");
  });

  it("a page without product data: the cheap model reads the price from its text (and not with llm: false)", async () => {
    const { items } = await read({ url: shop.url("/p/kettle") });
    expect(items[0]).toMatchObject({ title: "Steel kettle", price: 49.99, currency: "EUR", source: "page text (LLM)" });
    expect(llm.models).toEqual(["claude-haiku-5-5"]);
    expect(llm.prompts[0]).toMatch(/<content url="[^"]+\/p\/kettle">\nSteel kettle Now € 49,99 \(was € 59,99\)\. In stock\.\n<\/content>/);
    await expect(read({ url: shop.url("/p/kettle"), llm: false })).rejects.toThrow("the page has no product data, also in the browser (llm: false)");
  });

  it("reports a variant not offered or a page gone with that product, and fails only when none has a price", async () => {
    const { items, problems } = await read({
      products: [
        { url: shop.url("/p/jacket"), select: { size: "XL" } },
        { url: shop.url("/p/gone") },
        { url: shop.url("/p/jacket"), select: { size: "L" } },
      ],
    });
    expect(items.map((i) => i.price)).toEqual([null, null, 400]);
    expect(problems).toEqual([
      `${shop.url("/p/jacket")}: no variant with size XL (size: M, L)`,
      `${shop.url("/p/gone")}: the page is gone (404)`,
    ]);
    await expect(read({ url: shop.url("/p/gone") })).rejects.toThrow(`No price read: ${shop.url("/p/gone")}: the page is gone (404)`);
  });

  it("reads only allowed hosts, never private addresses, and follows no redirect elsewhere, in the browser neither", async () => {
    await expect(read({ url: shop.url("/p/jacket") }, ["other.test"])).rejects.toThrow("Refused: shop.localhost isn't in the pipeline's allowedDomains");
    await expect(read({ url: shop.url("/p/jacket", "inner.localhost") }, ["inner.localhost"])).rejects.toThrow(
      "Refused: inner.localhost resolves to a private or local address (10.0.0.5)",
    );
    await expect(read({ url: shop.url("/p/jacket", "inner.localhost"), browser: "always" }, ["inner.localhost"])).rejects.toThrow(
      "Refused: inner.localhost resolves to a private or local address (10.0.0.5)",
    );
    await expect(read({ url: shop.url("/p/away") })).rejects.toThrow("Refused: elsewhere.localhost isn't in the pipeline's allowedDomains");
    // The browser follows redirects on its own: each one is checked before it goes on.
    await expect(read({ url: shop.url("/p/away"), browser: "always" })).rejects.toThrow("Refused: elsewhere.localhost isn't in the pipeline's allowedDomains");
    expect(shop.requests.filter((r) => r.path === "/p/jacket")).toHaveLength(0);
    expect((await read({ url: shop.url("/p/moved"), browser: "always" })).items[0]).toMatchObject({ price: 343.16, source: "schema.org, in the browser" });
  });

  it("in a pipeline: the variant's price day by day, a message only when it went down", async () => {
    const telegram = new Counting("notify.telegram", () => ({ sent: true }));
    const runner = new PipelineRunner(db.client, defaultCatalog(), new ExecutorRegistry([step, new HistoryStep(db.client), new FilterStep(), telegram]));
    const versionId = await createVersion(db.client, userId, WATCH(shop.url("/p/jacket")), new PipelineCompiler(defaultCatalog()));
    const day = async (dryRun = false) => {
      const runId = await runner.start(versionId, { trigger: "manual", dryRun });
      expect(await runner.advance(runId)).toBe("DONE");
      return (await db.client.run.findUniqueOrThrow({ where: { runId } })).summary;
    };
    // A quiet run says why it said nothing, and what it read.
    expect(await day(true)).toBe(
      "Done, nothing to tell: cheaper.items and product.problems were empty, so tell and trouble were skipped. " +
        "A dry run saves nothing, so each one starts from scratch.\nSkogsö Padded Jacket (Black, M): 343.16 EUR, in stock",
    );
    expect(await day()).toBe(
      "Done, nothing to tell: cheaper.items and product.problems were empty, so tell and trouble were skipped.\nSkogsö Padded Jacket (Black, M): 343.16 EUR, in stock",
    );
    shop.price = 359;
    await day();
    expect(telegram.calls).toHaveLength(0);
    shop.price = 299.95;
    // A message went out: no "nothing to tell".
    expect(await day()).toBe("Done. product.problems was empty, so trouble was skipped.\nSkogsö Padded Jacket (Black, M): 299.95 EUR, in stock");
    expect(telegram.calls).toHaveLength(1);
    expect(String(telegram.calls[0].text)).toContain("299.95");
    expect((await db.client.dataPoint.findMany({ orderBy: { at: "asc" } })).map((p) => [p.key, p.value])).toEqual([
      [`${shop.url("/p/jacket")}#color=Black&size=M`, 343.16],
      [`${shop.url("/p/jacket")}#color=Black&size=M`, 359],
      [`${shop.url("/p/jacket")}#color=Black&size=M`, 299.95],
    ]);
  });
});

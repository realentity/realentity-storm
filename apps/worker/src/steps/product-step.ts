import { type LlmClient, type ModelRouter } from "@ai-me/llm";
import { hostMatches } from "@ai-me/shared";
import { z } from "zod";
import { SendGuard } from "../browser/agent-page";
import { blockingState } from "../browser/blocking";
import { type BrowserPool } from "../browser/browser-pool";
import { type StepContext } from "../runner/step-executor";
import { numberIn } from "./history-step";
import { FetchRefused, pageText, PublicHttp, USER_AGENT, type HttpFetchOptions } from "./http-steps";
import { DATA_ONLY, LlmStep } from "./llm-steps";

type Item = Record<string, unknown>;
type Select = Record<string, string>;

interface ProductInput {
  url?: string;
  urls?: string[];
  products?: { url: string; select?: Select }[];
  select?: Select;
  browser: "fallback" | "always" | "never";
  llm: boolean;
  timeoutSeconds: number;
}

/** One way to buy the product: a variant's offer, or the product's own. */
export interface Offer {
  price: number | null;
  currency: string | null;
  /** schema.org's name for it: InStock, OutOfStock, PreOrder… */
  availability: string | null;
  sku: string | null;
  /** The variant's attributes (size, color…), lowercase names. */
  attributes: Record<string, string>;
  name: string | null;
}

/** What a product page says about the product, from its machine-readable data. */
export interface ProductData {
  title: string | null;
  brand: string | null;
  offers: Offer[];
  source: "schema.org" | "meta tags";
}

/** Product pages are large (a shop's page with its variants: over 500 KB). */
const MAX_BYTES = 4 * 1024 * 1024;
/** The page text the LLM reads when nothing else gives a price. */
const MAX_PAGE_TEXT = 12_000;
const IN_STOCK = new Set(["InStock", "LimitedAvailability", "OnlineOnly", "InStoreOnly"]);
const ALIASES: Record<string, string> = { colour: "color", farbe: "color", größe: "size", groesse: "size" };

const PageProductSchema = z.object({
  found: z.boolean().describe("false when the page isn't one product's page"),
  title: z.string(),
  price: z.number().nullable().describe("the current selling price, as a number"),
  currency: z.string().nullable().describe("ISO code, e.g. EUR"),
  inStock: z.boolean().nullable().describe("whether it can be ordered now; null when the page doesn't say"),
  note: z.string().describe("one sentence: which price you took, and whether the page shows the variant's price"),
});

const SYSTEM =
  "You read one product from a shop page's text: its name, the current selling price as a number (not a crossed-out " +
  "price, an instalment or a shipping cost), its currency and whether it can be ordered now. With a variant given " +
  "(size, color), the price of that variant when the page shows prices per variant. " +
  `${DATA_ONLY} The page's text is in <content>.`;

/**
 * shop.product (M13 follow-up): the price of a product, or of a chosen variant (size, color), from its page. First
 * without a browser: the page's schema.org data (Product, ProductGroup with its variants, offers), else its price meta
 * tags. A page that refuses that or has neither is opened in the headless browser (data added by scripts, bot walls
 * that let a browser in); with no data there either, the cheap model reads the price from the page's text. Only hosts
 * on allowedDomains, never private addresses, and the browser's page goes nowhere else. One problem per product (a
 * size not offered, a page gone) is reported with that product; the step fails only when no product has a price.
 */
export class ProductStep extends LlmStep {
  readonly type = "shop.product";
  private readonly http: PublicHttp;

  constructor(
    llm: LlmClient,
    router: ModelRouter,
    options: HttpFetchOptions = {},
    private readonly pool?: BrowserPool,
  ) {
    super(llm, router);
    this.http = new PublicHttp(options);
  }

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { url, urls, products, select, browser, llm, timeoutSeconds } = input as unknown as ProductInput;
    if ([url, urls, products].filter((given) => given !== undefined).length !== 1) {
      throw new Error("shop.product reads `url`, `urls` or `products`: give one of them");
    }
    const wanted = products ?? (urls ?? [url!]).map((address) => ({ url: address, select: undefined }));
    const allowed = context.allowedDomains ?? [];
    const items: Item[] = [];
    for (const product of wanted) {
      items.push(await this.read(product.url, product.select ?? select ?? {}, allowed, { browser, llm, timeout: timeoutSeconds * 1000 }, context));
    }
    const problems = items.filter((item) => item.problem).map((item) => `${String(item.url)}: ${String(item.problem)}`);
    if (items.every((item) => item.price === null)) throw new Error(`No price read: ${problems.join("; ")}`);
    return { items, problems, report: items.map(reportOf).join("\n") };
  }

  private async read(
    url: string,
    select: Select,
    allowed: readonly string[],
    options: { browser: ProductInput["browser"]; llm: boolean; timeout: number },
    context: StepContext,
  ): Promise<Item> {
    let why = "browser: always";
    if (options.browser !== "always") {
      try {
        const response = await this.http.get(url, HEADERS, allowed, { maxBytes: MAX_BYTES, timeout: options.timeout });
        if (response.status === 404 || response.status === 410) return unread(url, select, `the page is gone (${response.status})`);
        if (response.status >= 200 && response.status <= 299) {
          const found = productOf(response.body.toString("utf8"));
          if (found) return itemOf(url, select, found);
          why = "the page has no product data";
        } else why = `the site answered ${response.status}`;
      } catch (error) {
        if (error instanceof FetchRefused) throw error;
        why = error instanceof Error ? error.message : String(error);
      }
      if (options.browser === "never") return unread(url, select, `${why} (browser: never)`);
    }
    if (!this.pool) return unread(url, select, `${why}, and this worker has no browser`);
    return this.inBrowser(url, select, allowed, options, context, why);
  }

  /** The page in the headless browser: its data once scripts ran, else the cheap model on its text. */
  private async inBrowser(
    url: string,
    select: Select,
    allowed: readonly string[],
    options: { llm: boolean; timeout: number },
    context: StepContext,
    why: string,
  ): Promise<Item> {
    await this.http.assertPublic(url, allowed);
    const lease = await this.pool!.lease(false, { acceptDownloads: false });
    try {
      const guard = new SendGuard((host) => hostMatches(host, allowed), "explore");
      await guard.install(lease.context);
      const page = await lease.context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeout }).catch((error: unknown) => {
        throw guard.refusedHost ? new FetchRefused(`Refused: ${guard.refusedHost} isn't in the pipeline's allowedDomains`) : error;
      });
      if (guard.refusedHost) throw new FetchRefused(`Refused: ${guard.refusedHost} isn't in the pipeline's allowedDomains`);
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
      const blocked = await blockingState(page);
      if (blocked) return unread(url, select, `${why}; in the browser, the site shows a check: ${blocked}`);
      const found = productOf(await page.content());
      if (found) return { ...itemOf(url, select, found), source: `${found.source}, in the browser` };
      if (!options.llm) return unread(url, select, `${why}, also in the browser (llm: false)`);
      const text = (await page.locator("body").innerText({ timeout: options.timeout })).replace(/\s+/g, " ").slice(0, MAX_PAGE_TEXT);
      return await this.fromText(url, select, text, context);
    } finally {
      await lease.close();
    }
  }

  private async fromText(url: string, select: Select, text: string, context: StepContext): Promise<Item> {
    const variant = describe(select);
    const answer = await this.call(
      context,
      SYSTEM,
      `<task>The product on this page${variant ? `, variant ${variant}` : ""}.</task>\n<content url="${url}">\n${text}\n</content>`,
      PageProductSchema,
    );
    if (!answer.found || answer.price === null) return unread(url, select, `no price on the page (${answer.note})`);
    return {
      ...unread(url, select, null),
      title: answer.title,
      price: answer.price,
      currency: answer.currency,
      inStock: answer.inStock,
      variant: Object.keys(select).length ? select : null,
      source: "page text (LLM)",
      note: answer.note,
    };
  }
}

const HEADERS = { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8", "accept-encoding": "gzip, deflate, br" };

/** The item for a product: the cheapest matching offer in stock (else the cheapest matching one). */
export function itemOf(url: string, select: Select, data: ProductData): Item {
  const base = { ...unread(url, select, null), title: data.title, brand: data.brand, variants: data.offers.length, source: data.source };
  const keys = Object.keys(select);
  const matching = data.offers.filter((offer) => matches(offer, select));
  if (keys.length && matching.length === 0) {
    return { ...base, matches: 0, problem: `no variant with ${describe(select)} (${available(data.offers, keys)})` };
  }
  const priced = matching.filter((offer) => offer.price !== null);
  if (priced.length === 0) return { ...base, matches: matching.length, problem: "its product data has no price" };
  const inStock = priced.filter((offer) => offer.availability !== null && IN_STOCK.has(offer.availability));
  const chosen = (inStock.length ? inStock : priced).reduce((low, offer) => (offer.price! < low.price! ? offer : low));
  const plain = data.offers.length === 1 && Object.keys(chosen.attributes).length === 0;
  return {
    ...base,
    price: chosen.price,
    currency: chosen.currency,
    availability: chosen.availability,
    inStock: chosen.availability === null ? null : IN_STOCK.has(chosen.availability),
    sku: chosen.sku,
    variant: Object.keys(chosen.attributes).length ? chosen.attributes : null,
    matches: matching.length,
    note:
      keys.length && plain
        ? "the page lists no variants: the price is the product's"
        : !keys.length && data.offers.length > 1
          ? `the cheapest of ${data.offers.length} variants${inStock.length ? " in stock" : ""}: choose one with select`
          : null,
  };
}

/** "Skogsö Padded Jacket (M, Black): 343.16 EUR, in stock", or what went wrong. */
function reportOf(item: Item): string {
  const variant = item.variant ? ` (${Object.values(item.variant as Record<string, string>).join(", ")})` : "";
  const name = `${String(item.title ?? item.url)}${variant}`;
  if (item.price === null) return `${name}: ${String(item.problem)}`;
  const stock = item.inStock === true ? ", in stock" : item.inStock === false ? ", sold out" : "";
  return `${name}: ${item.price as number}${typeof item.currency === "string" ? ` ${item.currency}` : ""}${stock}`;
}

/** An item without a price yet: `id` is the product and the variant asked for, the key for data.history. */
function unread(url: string, select: Select, problem: string | null): Item {
  const keys = Object.keys(select).sort();
  return {
    id: keys.length ? `${url}#${keys.map((k) => `${k}=${select[k]}`).join("&")}` : url,
    url,
    title: null,
    brand: null,
    price: null,
    currency: null,
    availability: null,
    inStock: null,
    sku: null,
    variant: null,
    variants: null,
    matches: null,
    source: null,
    note: null,
    problem,
  };
}

function matches(offer: Offer, select: Select): boolean {
  return Object.entries(select).every(([key, value]) => {
    const attribute = attributeOf(offer.attributes, key);
    if (attribute !== undefined) return norm(attribute) === norm(value);
    // Without that attribute, the variant's name: "Jacket - Autumn Leaf | XS".
    return (offer.name ?? "").split(/[|,/()]| - /).some((part) => norm(part) === norm(value));
  });
}

function attributeOf(attributes: Record<string, string>, key: string): string | undefined {
  const wanted = canonical(key);
  return Object.entries(attributes).find(([name]) => canonical(name) === wanted)?.[1];
}

/** What the variants offer for the attributes asked about: "size: XS, S, M; color: Black". */
function available(offers: Offer[], keys: string[]): string {
  return keys
    .map((key) => {
      const values = [...new Set(offers.map((offer) => attributeOf(offer.attributes, key)).filter((v): v is string => v !== undefined))];
      return values.length ? `${key}: ${values.slice(0, 30).join(", ")}` : `the variants have no ${key}`;
    })
    .join("; ");
}

const describe = (select: Select): string =>
  Object.entries(select)
    .map(([key, value]) => `${key} ${value}`)
    .join(", ");
const norm = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");
const canonical = (name: string): string => ALIASES[norm(name)] ?? norm(name);

/** A page's product: schema.org data (JSON-LD), else price meta tags; null when it has neither. */
export function productOf(html: string): ProductData | null {
  return fromJsonLd(html) ?? fromMeta(html);
}

const LD_JSON = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
/** Control characters some shops leave raw inside their JSON-LD strings. */
const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}]+`, "g");

function fromJsonLd(html: string): ProductData | null {
  const nodes: Item[] = [];
  for (const [, block] of html.matchAll(LD_JSON)) {
    try {
      collect(JSON.parse(block.trim().replace(CONTROL, " ")), nodes);
    } catch {
      // A block that isn't JSON: the others may still have the product.
    }
  }
  for (const group of nodes.filter((node) => typeIs(node, "ProductGroup"))) {
    const offers = list(group.hasVariant).flatMap((variant) => offersOf(variant));
    if (offers.length) return { title: text(group.name), brand: text(group.brand), offers, source: "schema.org" };
  }
  const products = nodes.filter((node) => typeIs(node, "Product") && offersOf(node).length > 0);
  if (products.length === 0) return null;
  // Several products with offers: a page listing its variants as products.
  return { title: text(products[0].name), brand: text(products[0].brand), offers: products.flatMap((p) => offersOf(p)), source: "schema.org" };
}

function collect(value: unknown, nodes: Item[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) collect(entry, nodes);
    return;
  }
  if (!isObject(value)) return;
  if (typeIs(value, "Product") || typeIs(value, "ProductGroup")) nodes.push(value);
  collect(value["@graph"], nodes);
  collect(value.mainEntity, nodes);
}

function offersOf(product: Item): Offer[] {
  const attributes: Record<string, string> = {};
  for (const name of ["color", "size", "material", "pattern"]) {
    const value = text(product[name]);
    if (value) attributes[name] = value;
  }
  for (const property of list(product.additionalProperty)) {
    const name = text(property.name);
    const value = text(property.value);
    if (name && value) attributes[name.toLowerCase()] = value;
  }
  const offer = (o: Item): Offer => {
    const specification = list(o.priceSpecification)[0] ?? {};
    return {
      price: numberIn(o.price ?? o.lowPrice ?? specification.price),
      currency: text(o.priceCurrency) ?? text(specification.priceCurrency),
      availability: text(o.availability)?.split("/").pop() ?? null,
      sku: text(product.sku) ?? text(o.sku),
      attributes,
      name: text(product.name) ?? text(o.name),
    };
  };
  return list(product.offers).flatMap((o) => (typeIs(o, "AggregateOffer") && o.offers ? list(o.offers).map(offer) : [offer(o)]));
}

/** og:/product: price meta tags and itemprop="price" (microdata). */
function fromMeta(html: string): ProductData | null {
  const values = new Map<string, string>();
  for (const [tag] of html.matchAll(/<(?:meta|span|div|link)\b[^>]*>/gi)) {
    const attrs = new Map<string, string>();
    for (const [, name, , double, single] of tag.matchAll(/([a-z][\w:-]*)\s*=\s*("([^"]*)"|'([^']*)')/gi)) attrs.set(name.toLowerCase(), double ?? single ?? "");
    const key = attrs.get("property") ?? attrs.get("name") ?? attrs.get("itemprop");
    const value = attrs.get("content") ?? attrs.get("href");
    if (key && value !== undefined && !values.has(key.toLowerCase())) values.set(key.toLowerCase(), pageText(value));
  }
  const price = numberIn(values.get("product:price:amount") ?? values.get("og:price:amount") ?? values.get("price"));
  if (price === null) return null;
  const stock = (values.get("product:availability") ?? values.get("og:availability") ?? values.get("availability") ?? "").toLowerCase().replace(/[^a-z]/g, "");
  const availability = stock.endsWith("instock") ? "InStock" : stock.includes("outofstock") || stock === "oos" ? "OutOfStock" : stock.endsWith("preorder") ? "PreOrder" : null;
  const title = values.get("og:title") ?? (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ? pageText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)![1]) : null);
  return {
    title: title || null,
    brand: values.get("product:brand") ?? null,
    offers: [
      {
        price,
        currency: values.get("product:price:currency") ?? values.get("og:price:currency") ?? values.get("pricecurrency") ?? null,
        availability,
        sku: values.get("sku") ?? null,
        attributes: {},
        name: title || null,
      },
    ],
    source: "meta tags",
  };
}

function typeIs(value: unknown, type: string): boolean {
  if (!isObject(value)) return false;
  return list(value["@type"]).some((t) => String(t["#"]).split("/").pop() === type);
}

/** A value or a list of them, as objects; plain values as { "#": value }. */
function list(value: unknown): Item[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? (value as unknown[]) : [value]).map((v) => (isObject(v) ? v : { "#": v }));
}

/** Text of a value: a string or number, or an object's name (a Brand, a SizeSpecification) or @value. */
function text(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (isObject(value)) return text(value.name ?? value["@value"] ?? value["#"]);
  return null;
}

function isObject(value: unknown): value is Item {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { type DataEntity, type Prisma, type PrismaClient } from "@realentity/storm-db";
import { entityItem, PRICE_WATCH_COLLECTION } from "@realentity/storm-shared";
import { offerKey, parseShopLine } from "@realentity/storm-steps";
import { type StepContext, type StepExecutor } from "../runner/step-executor";
import { appType } from "./entity-steps";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Prices kept per shop: a year of daily checks. */
const KEEP = 400;

type Item = Record<string, unknown>;

interface Product {
  name: string;
  targetPrice: number | null;
  currency: string | null;
  shops: string[];
}

interface Offer {
  key: string;
  shop: string;
  url: string;
  variant?: string;
  select?: Record<string, string>;
  /** What it read last time, when it read anything. */
  last: { price: number | null; inStock: boolean | null } | null;
}

interface Read {
  offer: Offer;
  shop: string;
  url: string;
  price: number | null;
  currency: string | null;
  inStock: boolean | null;
  title: string | null;
  problem: string | null;
}

/**
 * price.watch (M24): the user's enabled Products (a type of mine in the pipeline's App, M33), each shop line's page read by
 * shop.product (schema.org data, the browser, the cheap model, in that order). What each shop says is kept as an Offer
 * with its price history; a line the user removed takes its Offer off. What's new is told once: a shop crossing their
 * target, a new low over `lowestDays`, back in stock. The addresses are the user's, so each read may go to its own
 * shop only.
 */
export class PriceWatchStep implements StepExecutor {
  readonly type = "price.watch";

  constructor(
    private readonly prisma: PrismaClient,
    /** shop.product */
    private readonly product: StepExecutor,
  ) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { product: only, lowestDays } = input as { product?: string; lowestDays: number };
    const { appId } = await appType(this.prisma, context, "Product");
    await appType(this.prisma, context, "Offer");
    const rows = await this.prisma.dataEntity.findMany({ where: { appId, type: "Product", removedAt: null }, orderBy: { key: "asc" } });
    const watched = rows
      .map((row) => productOf(row))
      .filter((p) => p.enabled && (!only || p.name.toLowerCase() === only.toLowerCase()));
    if (only && watched.length === 0) throw new Error(`No watched product "${only}"`);
    const saved = new Map(
      (await this.prisma.dataEntity.findMany({ where: { appId, type: "Offer" } })).map((e) => [e.key, e]),
    );

    const products: Item[] = [];
    const news: Item[] = [];
    const problems: string[] = [];
    const report: string[] = [];
    for (const product of watched) {
      const offers: Offer[] = [];
      for (const line of product.shops) {
        const shop = parseShopLine(line);
        if (!shop) {
          problems.push(`${product.name}: "${line}" isn't an address (https://…, then "| size: M" for a variant)`);
          continue;
        }
        const key = offerKey(product.name, shop.url, shop.variant);
        const last = saved.get(key);
        const value = (last?.removedAt ? null : last?.value) as { price?: unknown; inStock?: unknown } | null | undefined;
        offers.push({
          key,
          shop: new URL(shop.url).hostname,
          url: shop.url,
          ...(shop.variant ? { variant: shop.variant, select: shop.select } : {}),
          last: value ? { price: typeof value.price === "number" ? value.price : null, inStock: typeof value.inStock === "boolean" ? value.inStock : null } : null,
        });
      }
      const reads: Read[] = [];
      for (const offer of offers) reads.push(await this.read(offer, context));
      const cheapest = cheapestOf(reads, product.currency);
      for (const read of reads) {
        if (read.price === null) {
          problems.push(`${product.name} at ${read.shop}: ${read.problem ?? "no price"}`);
          continue;
        }
        const why = await this.newsOf(context.userId, product, read, lowestDays);
        if (why.length) news.push({ product: product.name, shop: read.shop, url: read.url, price: read.price, currency: read.currency, why, cheapest: cheapest === read });
      }
      if (!context.dryRun) {
        for (const read of reads) await this.record(context.userId, appId, product.name, read, saved.get(read.offer.key));
        // A shop line the user removed: its Offer goes (its history stays, should the line come back).
        const kept = new Set(offers.map((o) => o.key));
        const gone = [...saved.values()].filter((e) => !e.removedAt && (e.value as Item).product === product.name && !kept.has(e.key));
        if (gone.length) await this.prisma.dataEntity.updateMany({ where: { dataEntityId: { in: gone.map((e) => e.dataEntityId) } }, data: { removedAt: new Date() } });
      }
      products.push({
        name: product.name,
        targetPrice: product.targetPrice,
        cheapest: cheapest && { shop: cheapest.shop, url: cheapest.url, price: cheapest.price, currency: cheapest.currency },
        offers: reads.map(({ offer, ...read }) => ({ ...read, ...(offer.variant ? { variant: offer.variant } : {}) })),
      });
      report.push(`${product.name}: ${cheapest ? `${money(cheapest.price!, cheapest.currency)} at ${cheapest.shop}` : "no price"}`);
    }
    return { products, news, text: textOf(news, products), problems, report: report.join("\n") };
  }

  private async read(offer: Offer, context: StepContext): Promise<Read> {
    const shop = offer.shop;
    try {
      const output = (await this.product.execute(
        { products: [{ url: offer.url, ...(offer.select ? { select: offer.select } : {}) }], browser: "fallback", llm: true, timeoutSeconds: 30 },
        { ...context, allowedDomains: [shop] },
      )) as { items: Item[] };
      const item = output.items[0] ?? {};
      return {
        offer,
        shop,
        url: offer.url,
        price: typeof item.price === "number" ? item.price : null,
        currency: typeof item.currency === "string" ? item.currency : null,
        inStock: typeof item.inStock === "boolean" ? item.inStock : null,
        title: typeof item.title === "string" ? item.title : null,
        problem: typeof item.problem === "string" ? item.problem : null,
      };
    } catch (error) {
      return { offer, shop, url: offer.url, price: null, currency: null, inStock: null, title: null, problem: error instanceof Error ? error.message : String(error) };
    }
  }

  /** What's new about this shop's price, compared with what it read before. */
  private async newsOf(userId: string, product: Product, read: Read, lowestDays: number): Promise<string[]> {
    const price = read.price!;
    const last = read.offer.last?.price ?? null;
    const target = product.targetPrice;
    const why: string[] = [];
    if (target !== null && comparable(product.currency, read.currency) && price <= target && (last === null || last > target)) {
      why.push(`at or under your target ${money(target, product.currency)}`);
    }
    const earlier = await this.prisma.dataPoint.findMany({
      where: { userId, collection: PRICE_WATCH_COLLECTION, key: read.offer.key, at: { gte: new Date(Date.now() - lowestDays * DAY_MS) } },
      select: { value: true },
    });
    if (earlier.length > 0 && price < Math.min(...earlier.map((p) => p.value))) why.push(`the lowest in ${lowestDays} days`);
    if (read.offer.last?.inStock === false && read.inStock === true) why.push("back in stock");
    return why;
  }

  /** The Offer: what it read now, or (when it read no price) what it read last with the problem. */
  private async record(userId: string, appId: string, product: string, read: Read, saved: DataEntity | undefined): Promise<void> {
    const key = read.offer.key;
    const previous = saved && !saved.removedAt ? (saved.value as Item) : {};
    const now = new Date();
    const value: Item = {
      ...(read.price === null ? previous : {}),
      offer: key,
      product,
      shop: read.shop,
      url: read.url,
      ...(read.offer.variant ? { variant: read.offer.variant } : {}),
      checkedAt: now.toISOString(),
      ...(read.price === null
        ? { problem: read.problem ?? "no price" }
        : withoutNulls({ price: read.price, currency: read.currency, inStock: read.inStock, title: read.title })),
    };
    if (read.price !== null) delete value.problem;
    await this.prisma.dataEntity.upsert({
      where: { appId_type_key: { appId, type: "Offer", key } },
      create: { appId, type: "Offer", key, value: value as Prisma.InputJsonObject, firstSeenAt: now, lastSeenAt: now },
      update: { value: value as Prisma.InputJsonObject, lastSeenAt: now, removedAt: null },
    });
    if (read.price === null) return;
    await this.prisma.dataPoint.create({ data: { userId, collection: PRICE_WATCH_COLLECTION, key, value: read.price, at: now } });
    const old = await this.prisma.dataPoint.findMany({
      where: { userId, collection: PRICE_WATCH_COLLECTION, key },
      orderBy: { at: "desc" },
      skip: KEEP,
      select: { dataPointId: true },
    });
    if (old.length) await this.prisma.dataPoint.deleteMany({ where: { dataPointId: { in: old.map((p) => p.dataPointId) } } });
  }
}

/** A Product entity as price.watch reads it: watched unless the user said not, its shops a line each. */
function productOf(row: DataEntity): Product & { enabled: boolean } {
  const item = entityItem(row.value, row.mine);
  const shops = Array.isArray(item.shops) ? item.shops.filter((s): s is string => typeof s === "string" && s.trim() !== "") : [];
  return {
    name: row.key,
    targetPrice: typeof item.targetPrice === "number" ? item.targetPrice : null,
    currency: typeof item.currency === "string" && item.currency ? item.currency.toUpperCase() : null,
    enabled: item.enabled !== false,
    shops,
  };
}

function withoutNulls(value: Item): Item {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined));
}

/** The lowest price not known to be sold out, in the target's currency when there is one. */
function cheapestOf(reads: Read[], currency: string | null): Read | null {
  const priced = reads.filter((r) => r.price !== null && r.inStock !== false && comparable(currency, r.currency));
  return priced.reduce<Read | null>((low, r) => (low === null || r.price! < low.price! ? r : low), null);
}

function comparable(target: string | null, currency: string | null): boolean {
  return !target || !currency || target === currency;
}

/** One line per piece of news, naming a cheaper shop when there is one. */
function textOf(news: Item[], products: Item[]): string {
  if (news.length === 0) return "";
  const lines = news.map((n) => {
    const product = products.find((p) => p.name === n.product);
    const cheapest = product?.cheapest as { shop: string; price: number; currency: string | null } | null;
    const elsewhere = !n.cheapest && cheapest ? ` (cheapest now: ${money(cheapest.price, cheapest.currency)} at ${cheapest.shop})` : "";
    return `${String(n.product)}: ${money(n.price as number, n.currency as string | null)} at ${String(n.shop)}, ${(n.why as string[]).join(", ")}${elsewhere}\n${String(n.url)}`;
  });
  return `Prices:\n${lines.join("\n")}`;
}

function money(amount: number, currency: string | null): string {
  return `${amount.toFixed(2)}${currency ? ` ${currency}` : ""}`;
}

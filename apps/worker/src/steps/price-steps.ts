import { Prisma, type PrismaClient, type WatchedOffer, type WatchedProduct } from "@ai-me/db";
import { PRICE_WATCH_COLLECTION } from "@ai-me/shared";
import { type StepContext, type StepExecutor } from "../runner/step-executor";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Prices kept per shop: a year of daily checks. */
const KEEP = 400;

type Item = Record<string, unknown>;

interface Read {
  offer: WatchedOffer;
  shop: string;
  url: string;
  price: number | null;
  currency: string | null;
  inStock: boolean | null;
  title: string | null;
  problem: string | null;
}

/**
 * price.watch (M24): the products on my Prices page, each shop's page read by shop.product (schema.org data, the
 * browser, the cheap model, in that order). Each price is kept per shop; what's new is told once: a shop crossing
 * my target, a new low over `lowestDays`, back in stock. The addresses are mine (the Prices page), so each read may go
 * to its own shop only.
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
    const watched = await this.prisma.watchedProduct.findMany({
      where: { userId: context.userId, enabled: true, ...(only ? { name: { equals: only, mode: "insensitive" } } : {}) },
      include: { offers: { orderBy: { dateCreated: "asc" } } },
      orderBy: { name: "asc" },
    });
    if (only && watched.length === 0) throw new Error(`No enabled product "${only}" on the Prices page`);

    const products: Item[] = [];
    const news: Item[] = [];
    const problems: string[] = [];
    const report: string[] = [];
    for (const product of watched) {
      const reads: Read[] = [];
      for (const offer of product.offers) reads.push(await this.read(offer, context));
      const cheapest = cheapestOf(reads, product.currency);
      for (const read of reads) {
        if (read.price === null) {
          problems.push(`${product.name} at ${read.shop}: ${read.problem ?? "no price"}`);
          continue;
        }
        const why = await this.newsOf(context.userId, product, read, lowestDays);
        if (why.length) news.push({ product: product.name, shop: read.shop, url: read.url, price: read.price, currency: read.currency, why, cheapest: cheapest === read });
      }
      for (const read of reads) if (!context.dryRun) await this.record(context.userId, read);
      products.push({
        name: product.name,
        targetPrice: product.targetPrice === null ? null : Number(product.targetPrice),
        cheapest: cheapest && { shop: cheapest.shop, url: cheapest.url, price: cheapest.price, currency: cheapest.currency },
        offers: reads.map(({ offer: _, ...read }) => read),
      });
      report.push(`${product.name}: ${cheapest ? `${money(cheapest.price!, cheapest.currency)} at ${cheapest.shop}` : "no price"}`);
    }
    return { products, news, text: textOf(news, products), problems, report: report.join("\n") };
  }

  private async read(offer: WatchedOffer, context: StepContext): Promise<Read> {
    const shop = new URL(offer.url).hostname;
    const select = (offer.select as Record<string, string> | null) ?? undefined;
    try {
      const output = (await this.product.execute(
        { products: [{ url: offer.url, ...(select ? { select } : {}) }], browser: "fallback", llm: true, timeoutSeconds: 30 },
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
  private async newsOf(userId: string, product: WatchedProduct, read: Read, lowestDays: number): Promise<string[]> {
    const price = read.price!;
    const last = read.offer.lastPrice === null ? null : Number(read.offer.lastPrice);
    const target = product.targetPrice === null ? null : Number(product.targetPrice);
    const why: string[] = [];
    if (target !== null && comparable(product.currency, read.currency) && price <= target && (last === null || last > target)) {
      why.push(`at or under your target ${money(target, product.currency)}`);
    }
    const earlier = await this.prisma.dataPoint.findMany({
      where: { userId, collection: PRICE_WATCH_COLLECTION, key: read.offer.watchedOfferId, at: { gte: new Date(Date.now() - lowestDays * DAY_MS) } },
      select: { value: true },
    });
    if (earlier.length > 0 && price < Math.min(...earlier.map((p) => p.value))) why.push(`the lowest in ${lowestDays} days`);
    if (read.offer.lastInStock === false && read.inStock === true) why.push("back in stock");
    return why;
  }

  private async record(userId: string, read: Read): Promise<void> {
    const key = read.offer.watchedOfferId;
    await this.prisma.watchedOffer.update({
      where: { watchedOfferId: key },
      data: {
        lastCheckedAt: new Date(),
        lastProblem: read.price === null ? read.problem : null,
        ...(read.price === null
          ? {}
          : { lastPrice: new Prisma.Decimal(read.price), lastCurrency: read.currency, lastInStock: read.inStock, lastTitle: read.title }),
      },
    });
    if (read.price === null) return;
    await this.prisma.dataPoint.create({ data: { userId, collection: PRICE_WATCH_COLLECTION, key, value: read.price, at: new Date() } });
    const old = await this.prisma.dataPoint.findMany({
      where: { userId, collection: PRICE_WATCH_COLLECTION, key },
      orderBy: { at: "desc" },
      skip: KEEP,
      select: { dataPointId: true },
    });
    if (old.length) await this.prisma.dataPoint.deleteMany({ where: { dataPointId: { in: old.map((p) => p.dataPointId) } } });
  }
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

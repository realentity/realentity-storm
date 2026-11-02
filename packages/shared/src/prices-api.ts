import { z } from "zod";

/**
 * pipelines/prices.yaml, for "Create the Prices pipeline" on the Prices page (the api image has no pipelines/
 * folder). A test keeps the two the same.
 */
export const PRICES_PIPELINE = `# M24: every morning, the products on the Prices page, at each of their shops; a message only when something is
# new: a shop at or under my target (once), the lowest in 90 days, back in stock, with the cheapest shop named.
# Add products on the Prices page: no allowedDomains needed here.
name: Prices
description: My watched products, told only when a price is worth knowing.
trigger: { schedule: "0 9 * * *", tz: Europe/Sofia }
steps:
  - id: watch
    type: price.watch
    with: { lowestDays: 90 }
  - id: tell
    type: notify.telegram
    when: "{{watch.text}}"
    with: { text: "{{watch.text}}" }
  - id: trouble
    type: notify.telegram
    when: "{{watch.problems}}"
    with: { text: "Prices: can't read {{watch.problems}}" }
`;

/** What checks the watched products: the pipelines whose current version has a price.watch step. */
export interface PricesStatusView {
  pipelines: { pipelineId: string; name: string; enabled: boolean }[];
}

/** The DataPoint collection price.watch keeps each shop's prices in (key: watchedOfferId). */
export const PRICE_WATCH_COLLECTION = "price-watch";

const Select = z.record(z.string().trim().min(1).max(40), z.string().trim().min(1).max(80));

/** A watched product as I enter it on the Prices page (M24). */
export const WatchedProductSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    targetPrice: z.number().positive().max(10_000_000).nullable().default(null),
    currency: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/, "a currency code, e.g. EUR")
      .nullable()
      .default(null),
    enabled: z.boolean().default(true),
    offers: z
      .array(z.object({ url: z.url({ protocol: /^https?$/ }), select: Select.optional() }).strict())
      .min(1)
      .max(10),
  })
  .strict();
export type WatchedProductRequest = z.input<typeof WatchedProductSchema>;

export interface WatchedOfferView {
  watchedOfferId: string;
  url: string;
  /** The shop's host. */
  shop: string;
  select: Record<string, string> | null;
  price: number | null;
  currency: string | null;
  inStock: boolean | null;
  title: string | null;
  problem: string | null;
  checkedAt: string | null;
}

export interface WatchedProductView {
  watchedProductId: string;
  name: string;
  targetPrice: number | null;
  currency: string | null;
  enabled: boolean;
  offers: WatchedOfferView[];
  /** The lowest price now, in stock (or not known to be sold out). */
  cheapest: WatchedOfferView | null;
}

/** A product's price history per shop, the last `days`. */
export interface PriceHistoryView {
  days: number;
  offers: { watchedOfferId: string; shop: string; currency: string | null; points: { at: string; value: number }[] }[];
}

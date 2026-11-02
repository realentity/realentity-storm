import { Prisma, type WatchedOffer, type WatchedProduct } from "@ai-me/db";
import {
  type CompiledDefinition,
  type PipelineDetailView,
  PRICE_WATCH_COLLECTION,
  PRICES_PIPELINE,
  type PricesStatusView,
  WatchedProductSchema,
  type PriceHistoryView,
  type WatchedOfferView,
  type WatchedProductView,
} from "@ai-me/shared";
import { Injectable, NotFoundException } from "@nestjs/common";
import { type z } from "zod";
import { PrismaService } from "../database/prisma.service";
import { PipelinesService } from "../pipelines/pipelines.service";

type WatchedProductBody = z.infer<typeof WatchedProductSchema>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The Prices page (M24): the products price.watch checks, and what it read. */
@Injectable()
export class PricesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pipelines: PipelinesService,
  ) {}

  /** The pipelines that check the watched products: the page says when none is enabled. */
  async status(userId: string): Promise<PricesStatusView> {
    const pipelines = await this.prisma.client.pipeline.findMany({
      where: { userId, currentVersionId: { not: null } },
      select: { pipelineId: true, name: true, enabled: true, currentVersionId: true },
      orderBy: { name: "asc" },
    });
    const versions = await this.prisma.client.pipelineVersion.findMany({
      where: { pipelineVersionId: { in: pipelines.map((p) => p.currentVersionId!) } },
      select: { pipelineVersionId: true, definition: true },
    });
    const watching = new Set(
      versions
        .filter((v) => (v.definition as unknown as CompiledDefinition).steps.some((step) => step.type === "price.watch"))
        .map((v) => v.pipelineVersionId),
    );
    return {
      pipelines: pipelines.filter((p) => watching.has(p.currentVersionId!)).map(({ pipelineId, name, enabled }) => ({ pipelineId, name, enabled })),
    };
  }

  /** The Prices pipeline from its template, off until I turn it on. */
  createPipeline(userId: string): Promise<PipelineDetailView> {
    return this.pipelines.create(userId, PRICES_PIPELINE);
  }

  async list(userId: string): Promise<WatchedProductView[]> {
    const products = await this.prisma.client.watchedProduct.findMany({
      where: { userId },
      include: { offers: { orderBy: { dateCreated: "asc" } } },
      orderBy: { name: "asc" },
    });
    return products.map(view);
  }

  async create(userId: string, body: WatchedProductBody): Promise<WatchedProductView> {
    const created = await this.prisma.client.watchedProduct.create({
      data: { userId, ...fields(body), offers: { create: body.offers.map(offerData) } },
      include: { offers: { orderBy: { dateCreated: "asc" } } },
    });
    return view(created);
  }

  /** Replaces the product; a shop page kept as it was (same address and variant) keeps its history. */
  async update(userId: string, watchedProductId: string, body: WatchedProductBody): Promise<WatchedProductView> {
    const existing = await this.find(userId, watchedProductId);
    const same = (offer: WatchedOffer, wanted: WatchedProductBody["offers"][number]) =>
      offer.url === wanted.url && JSON.stringify(offer.select ?? null) === JSON.stringify(wanted.select ?? null);
    const kept = existing.offers.filter((offer) => body.offers.some((wanted) => same(offer, wanted)));
    const added = body.offers.filter((wanted) => !existing.offers.some((offer) => same(offer, wanted)));
    await this.prisma.client.$transaction([
      this.prisma.client.watchedOffer.deleteMany({ where: { watchedProductId, watchedOfferId: { notIn: kept.map((o) => o.watchedOfferId) } } }),
      this.prisma.client.dataPoint.deleteMany({
        where: {
          userId,
          collection: PRICE_WATCH_COLLECTION,
          key: { in: existing.offers.filter((o) => !kept.includes(o)).map((o) => o.watchedOfferId) },
        },
      }),
      this.prisma.client.watchedProduct.update({
        where: { watchedProductId },
        data: { ...fields(body), offers: { create: added.map(offerData) } },
      }),
    ]);
    return view(await this.find(userId, watchedProductId));
  }

  async remove(userId: string, watchedProductId: string): Promise<void> {
    const product = await this.find(userId, watchedProductId);
    await this.prisma.client.$transaction([
      this.prisma.client.dataPoint.deleteMany({ where: { userId, collection: PRICE_WATCH_COLLECTION, key: { in: product.offers.map((o) => o.watchedOfferId) } } }),
      this.prisma.client.watchedProduct.delete({ where: { watchedProductId } }),
    ]);
  }

  async history(userId: string, watchedProductId: string, days = 90): Promise<PriceHistoryView> {
    const product = await this.find(userId, watchedProductId);
    const points = await this.prisma.client.dataPoint.findMany({
      where: { userId, collection: PRICE_WATCH_COLLECTION, key: { in: product.offers.map((o) => o.watchedOfferId) }, at: { gte: new Date(Date.now() - days * DAY_MS) } },
      orderBy: { at: "asc" },
    });
    return {
      days,
      offers: product.offers.map((offer) => ({
        watchedOfferId: offer.watchedOfferId,
        shop: hostOf(offer.url),
        currency: offer.lastCurrency,
        points: points.filter((p) => p.key === offer.watchedOfferId).map((p) => ({ at: p.at.toISOString(), value: p.value })),
      })),
    };
  }

  private async find(userId: string, watchedProductId: string) {
    const product = await this.prisma.client.watchedProduct.findFirst({
      where: { watchedProductId, userId },
      include: { offers: { orderBy: { dateCreated: "asc" } } },
    });
    if (!product) throw new NotFoundException();
    return product;
  }
}

function fields(body: WatchedProductBody) {
  return {
    name: body.name,
    targetPrice: body.targetPrice === null ? null : new Prisma.Decimal(body.targetPrice),
    currency: body.currency,
    enabled: body.enabled,
  };
}

function offerData(offer: WatchedProductBody["offers"][number]) {
  return { url: offer.url, select: offer.select && Object.keys(offer.select).length ? offer.select : Prisma.DbNull };
}

function view(product: WatchedProduct & { offers: WatchedOffer[] }): WatchedProductView {
  const offers = product.offers.map(offerView);
  const comparable = (o: WatchedOfferView) => !product.currency || !o.currency || o.currency === product.currency;
  const priced = offers.filter((o) => o.price !== null && o.inStock !== false && comparable(o));
  return {
    watchedProductId: product.watchedProductId,
    name: product.name,
    targetPrice: product.targetPrice === null ? null : Number(product.targetPrice),
    currency: product.currency,
    enabled: product.enabled,
    offers,
    cheapest: priced.reduce<WatchedOfferView | null>((low, o) => (low === null || o.price! < low.price! ? o : low), null),
  };
}

function offerView(offer: WatchedOffer): WatchedOfferView {
  return {
    watchedOfferId: offer.watchedOfferId,
    url: offer.url,
    shop: hostOf(offer.url),
    select: (offer.select as Record<string, string> | null) ?? null,
    price: offer.lastPrice === null ? null : Number(offer.lastPrice),
    currency: offer.lastCurrency,
    inStock: offer.lastInStock,
    title: offer.lastTitle,
    problem: offer.lastProblem,
    checkedAt: offer.lastCheckedAt?.toISOString() ?? null,
  };
}

function hostOf(url: string): string {
  return new URL(url).hostname;
}

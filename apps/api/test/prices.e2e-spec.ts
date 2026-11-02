import { createPrismaConnection, type PrismaConnection } from "@ai-me/db";
import { PRICE_WATCH_COLLECTION, type PriceHistoryView, type WatchedProductView } from "@ai-me/shared";
import { TestEnvironment } from "@ai-me/testing";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

// M24-T1, T2: the Prices page
describe("prices", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;
  let userId: string;

  beforeAll(async () => {
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  afterEach(async () => {
    await db.client.watchedProduct.deleteMany();
    await db.client.dataPoint.deleteMany();
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  const JACKET = {
    name: "Jacket",
    targetPrice: 300,
    currency: "EUR",
    offers: [{ url: "https://one.example/jacket", select: { size: "M" } }, { url: "https://two.example/p/7" }],
  };

  it("watched products with their shops; an edit keeps the history of a shop it keeps; the cheapest in stock", async () => {
    const created = (await agent.post("/api/prices").send(JACKET).expect(201)).body as WatchedProductView;
    expect(created).toMatchObject({ name: "Jacket", targetPrice: 300, currency: "EUR", enabled: true, cheapest: null });
    expect(created.offers.map((o) => [o.shop, o.select])).toEqual([
      ["one.example", { size: "M" }],
      ["two.example", null],
    ]);

    // What price.watch leaves: the last read on each shop, and its history.
    const [one, two] = created.offers;
    await db.client.watchedOffer.update({ where: { watchedOfferId: one.watchedOfferId }, data: { lastPrice: 310, lastCurrency: "EUR", lastInStock: true } });
    await db.client.watchedOffer.update({ where: { watchedOfferId: two.watchedOfferId }, data: { lastPrice: 290, lastCurrency: "EUR", lastInStock: false } });
    for (const [offer, value, daysAgo] of [
      [one, 320, 3],
      [one, 310, 1],
      [two, 290, 1],
      [one, 400, 200],
    ] as const) {
      await db.client.dataPoint.create({ data: { userId, collection: PRICE_WATCH_COLLECTION, key: offer.watchedOfferId, value, at: new Date(Date.now() - daysAgo * 86_400_000) } });
    }
    const [listed] = (await agent.get("/api/prices").expect(200)).body as WatchedProductView[];
    expect(listed?.cheapest).toMatchObject({ shop: "one.example", price: 310 });

    const history = (await agent.get(`/api/prices/${created.watchedProductId}/history`).expect(200)).body as PriceHistoryView;
    expect(history.offers.map((o) => [o.shop, o.points.map((p) => p.value)])).toEqual([
      ["one.example", [320, 310]],
      ["two.example", [290]],
    ]);

    // Shop two replaced by three; shop one kept with its history.
    const edited = (
      await agent
        .put(`/api/prices/${created.watchedProductId}`)
        .send({ ...JACKET, targetPrice: null, offers: [JACKET.offers[0], { url: "https://three.example/j" }] })
        .expect(200)
    ).body as WatchedProductView;
    expect(edited.targetPrice).toBeNull();
    expect(edited.offers.map((o) => o.shop)).toEqual(["one.example", "three.example"]);
    expect(edited.offers[0]?.watchedOfferId).toBe(one.watchedOfferId);
    expect(await db.client.dataPoint.count({ where: { key: two.watchedOfferId } })).toBe(0);
    expect(await db.client.dataPoint.count({ where: { key: one.watchedOfferId } })).toBe(3);

    await agent.delete(`/api/prices/${created.watchedProductId}`).expect(204);
    expect(await db.client.dataPoint.count()).toBe(0);
    await agent.get(`/api/prices/${created.watchedProductId}/history`).expect(404);
  });

  it("refuses a page that isn't http(s), no shops, or a currency that isn't a code", async () => {
    await agent.post("/api/prices").send({ ...JACKET, offers: [{ url: "file:///etc/passwd" }] }).expect(400);
    await agent.post("/api/prices").send({ ...JACKET, offers: [] }).expect(400);
    await agent.post("/api/prices").send({ ...JACKET, currency: "euro" }).expect(400);
    expect(await db.client.watchedProduct.count()).toBe(0);
  });
});

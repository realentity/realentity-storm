import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { type AppDetailView, type AppImportResult, type AppListView, type InsightView } from "@realentity/storm-shared";
import { TestEnvironment } from "@realentity/storm-testing";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

const BILLS_APP = readFileSync(join(__dirname, "../../../pipelines/apps/bills.yaml"), "utf8");
const PRICES_APP = readFileSync(join(__dirname, "../../../pipelines/apps/prices.yaml"), "utf8");
const JOBS_APP = readFileSync(join(__dirname, "../../../pipelines/apps/job-search.yaml"), "utf8");
const RELEASES_APP = readFileSync(join(__dirname, "../../../pipelines/apps/releases.yaml"), "utf8");
const TABLES_APP = readFileSync(join(__dirname, "../../../pipelines/apps/tables.yaml"), "utf8");

// M33-I1 (Bills): the old Bills page's rows moved into the Bills App, once; its list as the old page showed them
describe("moving into an App", () => {
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
    await db.client.app.deleteMany();
    await db.client.bill.deleteMany();
    await db.client.watchedProduct.deleteMany();
    await db.client.dataPoint.deleteMany();
    await db.client.jobPosting.deleteMany();
    await db.client.dataRecord.deleteMany();
    await db.client.$executeRaw`DELETE FROM pgboss.job`;
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  const oldBill = (issuer: string, amount: number, dueDate: string | null, period: string | null, paidAt: Date | null = null) =>
    db.client.bill.create({
      data: {
        userId,
        issuer,
        issuerKey: `${issuer.toLowerCase()}.test`,
        billKey: `${issuer.toLowerCase()}.test|${period ?? dueDate}`,
        amount,
        currency: "BGN",
        dueDate: dueDate ? new Date(`${dueDate}T00:00:00Z`) : null,
        period,
        messageId: `<${issuer}@test>`,
        from: `billing@${issuer.toLowerCase()}.test`,
        subject: `${issuer} bill`,
        paidAt,
        dateCreated: new Date("2026-10-28T10:00:00Z"),
      },
    });

  it("moves every bill once, paid ones as paid, and the list shows each month with its total and what is unpaid", async () => {
    await oldBill("EVN", 84.2, "2026-11-20", "2026-11");
    await oldBill("Water", 21.5, "2026-11-10", null, new Date("2026-11-02T09:00:00Z"));
    await oldBill("Telco", 30, null, "2026-10");
    const app = (await agent.post("/api/apps").send({ source: BILLS_APP }).expect(201)).body as AppDetailView;
    expect(app.imports).toEqual([{ from: "bills", label: "the Bills page", count: 3 }]);

    expect((await agent.post(`/api/apps/${app.appId}/import`).send({ from: "bills" }).expect(201)).body as AppImportResult).toEqual({
      moved: 3,
      skipped: 0,
    });
    // All of it here: no longer offered; a new one on the old page is, alone.
    const detail = async () => ((await agent.get(`/api/apps/${app.appId}`).expect(200)).body as AppDetailView).imports;
    expect(await detail()).toEqual([]);
    await oldBill("Gas", 40, "2026-11-25", "2026-11");
    expect(await detail()).toEqual([{ from: "bills", label: "the Bills page", count: 1 }]);
    expect((await agent.post(`/api/apps/${app.appId}/import`).send({ from: "bills" }).expect(201)).body as AppImportResult).toEqual({
      moved: 1,
      skipped: 3,
    });

    const water = await db.client.dataEntity.findFirstOrThrow({ where: { key: "water.test|2026-11-10" } });
    expect([water.stage, water.stageDates, water.value]).toEqual([
      "paid",
      { due: "2026-10-28T10:00:00.000Z", paid: "2026-11-02T09:00:00.000Z" },
      expect.objectContaining({ issuer: "Water", amount: 21.5, dueDate: "2026-11-10", month: "2026-11-01" }),
    ]);

    const list = (await agent.get(`/api/apps/${app.appId}/pages/Bill`).expect(200)).body as AppListView;
    expect(list.groups?.map((g) => [g.label, g.count, g.totals.map((t) => t.sums)])).toEqual([
      ["2026-11", 3, [{ BGN: 145.7 }, { BGN: 124.2 }]],
      ["2026-10", 1, [{ BGN: 30 }, { BGN: 30 }]],
    ]);
    // Due first in a month; each row's moves.
    expect(list.rows.map((r) => r.key)).toEqual(["water.test|2026-11-10", "evn.test|2026-11", "gas.test|2026-11", "telco.test|2026-10"]);
    expect(list.page.moves).toEqual({ field: "status", to: { due: ["paid"], paid: ["due"] } });
    expect(list.page.columns[2]).toMatchObject({ field: "dueDate", due: { days: 3, unless: { status: "paid" } } });
  });

  // M33-I1 (Prices)
  it("moves products with their shops as lines, each offer's last reading, and its price history", async () => {
    const jacket = await db.client.watchedProduct.create({
      data: {
        userId,
        name: "Jacket",
        targetPrice: 300,
        currency: "EUR",
        offers: {
          create: [
            { url: "https://one.test/jacket", select: { size: "M", color: "Black" }, lastPrice: 320, lastCurrency: "EUR", lastInStock: true, lastCheckedAt: new Date("2026-11-02T07:00:00Z") },
            { url: "https://two.test/p/7", lastProblem: "No price read" },
          ],
        },
      },
      include: { offers: { orderBy: { dateCreated: "asc" } } },
    });
    await db.client.watchedProduct.create({ data: { userId, name: "Kettle", enabled: false } });
    const first = jacket.offers.find((o) => o.url === "https://one.test/jacket")!;
    await db.client.dataPoint.createMany({
      data: [330, 320].map((value, i) => ({ userId, collection: "price-watch", key: first.watchedOfferId, value, at: new Date(Date.UTC(2026, 10, 1 + i)) })),
    });

    const app = (await agent.post("/api/apps").send({ source: PRICES_APP }).expect(201)).body as AppDetailView;
    expect(app.imports).toEqual([{ from: "prices", label: "the Prices page", count: 2 }]);
    expect((await agent.post(`/api/apps/${app.appId}/import`).send({ from: "prices" }).expect(201)).body as AppImportResult).toEqual({ moved: 2, skipped: 0 });
    expect((await agent.post(`/api/apps/${app.appId}/import`).send({ from: "prices" }).expect(201)).body as AppImportResult).toEqual({ moved: 0, skipped: 2 });

    const products = await db.client.dataEntity.findMany({ where: { appId: app.appId, type: "Product" }, orderBy: { key: "asc" } });
    expect(products.map((p) => [p.key, p.mine])).toEqual([
      ["Jacket", { targetPrice: 300, currency: "EUR", enabled: true, shops: ["https://one.test/jacket | size: M, color: Black", "https://two.test/p/7"] }],
      ["Kettle", { enabled: false, shops: [] }],
    ]);
    const key = "Jacket | https://one.test/jacket | size: M, color: Black";
    const offer = await db.client.dataEntity.findFirstOrThrow({ where: { appId: app.appId, type: "Offer", key } });
    expect(offer.value).toEqual({
      offer: key,
      product: "Jacket",
      shop: "one.test",
      url: "https://one.test/jacket",
      variant: "size: M, color: Black",
      price: 320,
      currency: "EUR",
      inStock: true,
      checkedAt: "2026-11-02T07:00:00.000Z",
    });
    expect((await db.client.dataPoint.findMany({ where: { key }, orderBy: { at: "asc" } })).map((p) => p.value)).toEqual([330, 320]);
    // The Offer's own page charts it.
    const page = (await agent.get(`/api/apps/${app.appId}/pages/Offer/${encodeURIComponent(key)}`).expect(200)).body as { history: { value: number }[] };
    expect(page.history.map((p) => p.value)).toEqual([330, 320]);
  });

  // M33-I1 (Job Search)
  it("moves jobs at the stage their application reached, with its dates; Insight counts them the same; a hand move still tells application.status", async () => {
    const posting = (key: string, status: "NEW" | "SKIPPED" | "SHORTLISTED" | "APPLIED", score: number | null) =>
      db.client.jobPosting.create({
        data: { userId, source: "dev.bg/search", url: `https://dev.bg/company/jobads/${key}/`, title: `${key} engineer`, company: key, score, status, firstSeenAt: new Date(Date.now() - 10 * 86_400_000) },
      });
    const days = (n: number) => new Date(Date.now() - n * 86_400_000);
    const acme = await posting("acme", "APPLIED", 85);
    await db.client.application.create({
      data: { userId, jobPostingId: acme.jobPostingId, status: "REJECTED", submittedAt: days(9), respondedAt: days(7), interviewAt: days(5), rejectedAt: days(2), notes: "Nice people" },
    });
    const globex = await posting("globex", "APPLIED", 65);
    await db.client.application.create({ data: { userId, jobPostingId: globex.jobPostingId, status: "SUBMITTED", submittedAt: days(8) } });
    await posting("initech", "SKIPPED", 30);
    await posting("hooli", "NEW", null);
    const before = (await agent.get("/api/insight?days=30").expect(200)).body as InsightView;

    const app = (await agent.post("/api/apps").send({ source: JOBS_APP }).expect(201)).body as AppDetailView;
    expect(app.imports).toEqual([{ from: "jobs", label: "the Jobs page", count: 4 }]);
    expect((await agent.post(`/api/apps/${app.appId}/import`).send({ from: "jobs" }).expect(201)).body as AppImportResult).toEqual({ moved: 4, skipped: 0 });
    const jobs = await db.client.dataEntity.findMany({ where: { appId: app.appId, type: "Job" }, orderBy: { key: "asc" } });
    expect(jobs.map((j) => [j.key.split("/")[5], j.stage, Object.keys(j.stageDates as object).sort()])).toEqual([
      ["acme", "rejected", ["applied", "interview", "new", "prepared", "rejected", "responded"]],
      ["globex", "applied", ["applied", "new", "prepared"]],
      ["hooli", "new", ["new"]],
      ["initech", "skipped", ["new", "skipped"]],
    ]);
    expect(jobs[0]?.mine).toEqual({ comments: "Nice people" });

    // Insight now reads the Jobs, and counts what it counted.
    const after = (await agent.get("/api/insight?days=30").expect(200)).body as InsightView;
    expect(after.totals).toEqual(before.totals);
    expect(after.byScore).toEqual(before.byScore);
    expect(after.medianDaysToAnswer).toBe(before.medianDaysToAnswer);

    // By hand on its page: globex to an interview, told as application.status for the pipelines on it.
    await db.client.$executeRaw`DELETE FROM pgboss.job`;
    await agent.put(`/api/apps/${app.appId}/pages/Job/${encodeURIComponent("https://dev.bg/company/jobads/globex/")}/stage`).send({ to: "interview" }).expect(200);
    const events = await db.client.$queryRaw<{ data: { event: string; data: Record<string, unknown> } }[]>`SELECT data FROM pgboss.job WHERE name = 'pipeline-events' ORDER BY created_on`;
    expect(events.map((e) => [e.data.event, e.data.data.status ?? (e.data.data.stage as { to: string }).to])).toEqual([
      ["entity.changed", "interview"],
      ["application.status", "INTERVIEW"],
    ]);
  });

  // M33-T5: a page's collection (M27's view:) into an App's type
  it("moves a collection into a type, a mark as the yes/no field (mine) of its name; a list draws its history chart", async () => {
    const release = (id: string, title: string, marks: Record<string, string> = {}, removedAt: Date | null = null) =>
      db.client.dataRecord.create({
        data: { userId, collection: "releases", key: id, value: { id, title, published: "2026-11-01T10:00:00Z", url: `https://github.com/acme/app/releases/${id}` }, marks, removedAt },
      });
    await release("v1", "v1.0.0", { upgraded: "2026-11-02T10:00:00.000Z" });
    await release("v2", "v2.0.0");
    await release("v0", "v0.9.0", {}, new Date());
    await db.client.dataRecord.create({ data: { userId, collection: "releases", key: "bad", value: { title: "no id" } } });

    const app = (await agent.post("/api/apps").send({ source: RELEASES_APP }).expect(201)).body as AppDetailView;
    expect(app.imports).toEqual([{ from: "collection", collection: "releases", label: 'the "releases" collection', count: 4 }]);
    await agent.post(`/api/apps/${app.appId}/import`).send({ from: "collection", collection: "releases" }).expect(400);
    const moved = (await agent.post(`/api/apps/${app.appId}/import`).send({ from: "collection", collection: "releases", type: "Release" }).expect(201)).body as AppImportResult;
    expect(moved).toEqual({ moved: 3, skipped: 1 });
    const releases = await db.client.dataEntity.findMany({ where: { appId: app.appId, type: "Release" }, orderBy: { key: "asc" } });
    expect(releases.map((r) => [r.key, r.mine, r.removedAt !== null])).toEqual([
      ["v0", {}, true],
      ["v1", { upgraded: true }, false],
      ["v2", {}, false],
    ]);
    expect(releases[1]?.value).toMatchObject({ published: "2026-11-01T10:00:00.000Z", url: "https://github.com/acme/app/releases/v1" });

    const tables = (await agent.post("/api/apps").send({ source: TABLES_APP }).expect(201)).body as AppDetailView;
    await db.client.dataEntity.createMany({ data: [{ appId: tables.appId, type: "Table", key: "orders", value: { name: "orders", rows: 120 } }] });
    await db.client.dataPoint.createMany({
      data: [100, 120].map((value, i) => ({ userId, collection: "table-rows", key: "orders", value, at: new Date(Date.UTC(2026, 10, 1, i)) })),
    });
    const list = (await agent.get(`/api/apps/${tables.appId}/pages/Table`).expect(200)).body as AppListView;
    expect(list.chart).toEqual({ series: [{ key: "orders", label: "orders", points: [expect.objectContaining({ value: 100 }), expect.objectContaining({ value: 120 })] }], more: 0 });
  });

  it("offers nothing to an App without a Bill type bill.save could write, and refuses the move", async () => {
    await oldBill("EVN", 84.2, "2026-11-20", "2026-11");
    const app = (
      await agent
        .post("/api/apps")
        .send({
          source: BILLS_APP.replace(
            "amount: { type: money, required: true, currency: currency }",
            "amount: { type: number, required: true }",
          ),
        })
        .expect(201)
    ).body as AppDetailView;
    expect(app.imports).toEqual([]);
    await agent.post(`/api/apps/${app.appId}/import`).send({ from: "bills" }).expect(409);
  });
});

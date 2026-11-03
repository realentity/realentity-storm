import { createPrismaConnection, type Prisma, type PrismaConnection } from "@ai-me/db";
import { type AppDetailView, type AppEntityView, type AppListView, type AppMenuItem } from "@ai-me/shared";
import { TestEnvironment } from "@ai-me/testing";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

const BILLS = `
name: Bills
icon: receipt
types:
  Bill:
    key: id
    title: payee
    fields:
      id: { type: text, required: true }
      payee: { type: text, required: true }
      amount: { type: money, currency: currency }
      currency: { type: text }
      due: { type: date }
      status: { type: enum, values: [due, paid, late] }
      paid: { type: yesno, mine: true }
  Payee:
    key: name
    fields:
      name: { type: text, required: true }
pages:
  - list: Bill
    menu: { label: My bills }
    filters: [status, paid]
    sort: -due
    group: { by: due, period: month, totals: [amount] }
    removed: true
  - view: Bill
    history: { collection: bill-amounts }
  - list: Payee
    menu: false
`;

// M31-I1: an App's pages
describe("app pages", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;
  let userId: string;
  let appId: string;

  beforeAll(async () => {
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(async () => {
    appId = ((await agent.post("/api/apps").send({ source: BILLS }).expect(201)).body as AppDetailView).appId;
    const bill = (id: string, value: Prisma.InputJsonObject, extra: Partial<Prisma.DataEntityCreateManyInput> = {}) => ({
      appId,
      type: "Bill",
      key: id,
      value: { id, ...value },
      ...extra,
    });
    await db.client.dataEntity.createMany({
      data: [
        bill("e1", { payee: "Electricity", amount: 120.5, currency: "BGN", due: "2026-11-10", status: "due" }),
        bill("w1", { payee: "Water", amount: 30, currency: "BGN", due: "2026-11-20", status: "paid" }, { mine: { paid: true } }),
        bill("n1", { payee: "Netflix", amount: 12.99, currency: "EUR", due: "2026-11-05", status: "due" }),
        bill("e0", { payee: "Electricity", amount: 99, currency: "BGN", due: "2026-10-10", status: "paid" }),
        bill("x1", { payee: "No date", amount: 5, currency: "BGN" }),
        bill("old", { payee: "Old gym", amount: 40, currency: "BGN", due: "2026-09-01" }, { removedAt: new Date() }),
      ],
    });
    await db.client.dataPoint.createMany({
      data: [
        { userId, collection: "bill-amounts", key: "e1", value: 110, at: new Date("2026-10-10") },
        { userId, collection: "bill-amounts", key: "e1", value: 120.5, at: new Date("2026-11-10") },
        { userId, collection: "other", key: "e1", value: 1 },
      ],
    });
  });

  afterEach(async () => {
    await db.client.app.deleteMany();
    await db.client.dataPoint.deleteMany();
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  const list = async (query = "") => (await agent.get(`/api/apps/${appId}/pages/Bill${query}`).expect(200)).body as AppListView;
  const keys = (view: AppListView) => view.rows.map((r) => r.key);

  it("puts the lists in the menu, those hidden from it left out", async () => {
    expect((await agent.get("/api/apps/menu").expect(200)).body as AppMenuItem[]).toEqual([
      { appId, appName: "Bills", type: "Bill", label: "My bills", icon: "receipt" },
    ]);
  });

  it("groups by month, newest first, with totals per currency; rows in each group by the page's sort", async () => {
    const view = await list();
    expect(view.counts).toEqual({ current: 5, removed: 1 });
    expect(view.groups).toEqual([
      { value: "2026-11", label: "2026-11", count: 3, totals: [{ field: "amount", sums: { BGN: 150.5, EUR: 12.99 } }] },
      { value: "2026-10", label: "2026-10", count: 1, totals: [{ field: "amount", sums: { BGN: 99 } }] },
      { value: null, label: "—", count: 1, totals: [{ field: "amount", sums: { BGN: 5 } }] },
    ]);
    expect(keys(view)).toEqual(["w1", "e1", "n1", "e0", "x1"]);
    // My fields over what pipelines wrote.
    expect(view.rows[0]?.value).toMatchObject({ payee: "Water", paid: true });
  });

  it("filters, searches, pages and shows the removed apart", async () => {
    expect(keys(await list(`?filter=${encodeURIComponent('{"status":"due"}')}`))).toEqual(["e1", "n1"]);
    expect(keys(await list(`?filter=${encodeURIComponent('{"paid":"true"}')}`))).toEqual(["w1"]);
    expect(keys(await list("?q=electric"))).toEqual(["e1", "e0"]);
    const paged = await list("?offset=1&limit=2");
    expect([keys(paged), paged.total, paged.groups?.length]).toEqual([["e1", "n1"], 5, 3]);
    expect(keys(await list("?tab=removed"))).toEqual(["old"]);
    await agent.get(`/api/apps/${appId}/pages/Bill?filter=${encodeURIComponent('{"payee":"Water"}')}`).expect(400);
    await agent.get(`/api/apps/${appId}/pages/Bill?filter=nope`).expect(400);
    await agent.get(`/api/apps/${appId}/pages/Invoice`).expect(404);
  });

  it("an entity's page: its fields as the view says, its history by its key", async () => {
    const view = (await agent.get(`/api/apps/${appId}/pages/Bill/e1`).expect(200)).body as AppEntityView;
    expect(view).toMatchObject({ app: "Bills", type: "Bill", list: { label: "My bills", title: "payee" }, row: { key: "e1" } });
    expect(view.page.sections[0]?.fields.map((f) => f.field)).toEqual(["id", "payee", "amount", "currency", "due", "status", "paid"]);
    expect(view.history?.map((p) => p.value)).toEqual([110, 120.5]);
    await agent.get(`/api/apps/${appId}/pages/Bill/nope`).expect(404);
  });
});

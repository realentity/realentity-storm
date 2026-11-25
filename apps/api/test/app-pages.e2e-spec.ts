import { createPrismaConnection, type Prisma, type PrismaConnection } from "@realentity/storm-db";
import { type AppDetailView, type AppEntityView, type AppListView, type AppMenuItem, type AppReportView } from "@realentity/storm-shared";
import { TestEnvironment } from "@realentity/storm-testing";
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
      labels: { type: list, of: text }
  Payee:
    key: name
    fields:
      name: { type: text, required: true }
pages:
  - list: Bill
    menu: { label: My bills }
    filters: [status, paid, labels, due]
    sources:
      labels: { from: Bill, distinct: labels }
      days: { from: Bill, distinct: due, by: day }
      payees: { from: Payee, sort: name }
      unpaid: { from: Bill, where: [{ field: status, op: eq, value: due }], sort: payee, display: payee }
    sort: -due
    group: { by: due, period: month, totals: [amount] }
    removed: true
  - view: Bill
    history: { collection: bill-amounts }
  - list: Payee
    menu: false
  - report: Bill
    date: due
    periods: [30]
    tiles:
      - { label: Bills, count: true }
      - { label: Amount, sum: amount }
      - { label: Unpaid, sum: amount, when: { status: due } }
    trends:
      - { label: Amount, sum: amount, every: month }
    tables:
      - { by: payee, columns: [Bills, Amount] }
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
        bill("e1", { payee: "Electricity", amount: 120.5, currency: "BGN", due: "2026-11-10", status: "due", labels: ["Home", "utilities"] }),
        bill("w1", { payee: "Water", amount: 30, currency: "BGN", due: "2026-11-20", status: "paid" }, { mine: { paid: true } }),
        bill("n1", { payee: "Netflix", amount: 12.99, currency: "EUR", due: "2026-11-05", status: "due", labels: "streaming" }),
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
    await db.client.pipeline.deleteMany();
    await db.client.app.deleteMany();
    await db.client.dataPoint.deleteMany();
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  const list = async (query = "") => (await agent.get(`/api/apps/${appId}/pages/Bill${query}`).expect(200)).body as AppListView;
  const keys = (view: AppListView) => view.rows.map((r) => r.key);

  it("puts each App on the launcher: its lists in the menu, those hidden from it left out, then the reports", async () => {
    expect((await agent.get("/api/apps/menu").expect(200)).body as AppMenuItem[]).toEqual([
      {
        appId,
        name: "Bills",
        icon: "receipt",
        description: null,
        pages: [
          { kind: "list", type: "Bill", label: "My bills", icon: "receipt" },
          { kind: "report", type: "Bill", label: "Bill report", icon: "chart" },
        ],
        nothingOn: false,
        pending: 0,
        pinned: false,
      },
    ]);
  });

  it("pins an App to the sidebar and takes it off; only an App of mine", async () => {
    const pinned = async () => ((await agent.get("/api/apps/menu").expect(200)).body as AppMenuItem[])[0]?.pinned;
    await agent.put(`/api/apps/${appId}/pinned`).send({ pinned: true }).expect(204);
    expect(await pinned()).toBe(true);
    await agent.put(`/api/apps/${appId}/pinned`).send({ pinned: false }).expect(204);
    expect(await pinned()).toBe(false);
    await agent.put(`/api/apps/${appId}/pinned`).send({ pinned: "yes" }).expect(400);
    await agent.put("/api/apps/00000000-0000-4000-8000-000000000000/pinned").send({ pinned: true }).expect(404);
  });

  it("reports counts and sums per currency, a trend and a table, over the period picked", async () => {
    const report = async (query = "") => (await agent.get(`/api/apps/${appId}/reports/Bill${query}`).expect(200)).body as AppReportView;
    // All time: every bill, a removed one and one without a due date too.
    const all = await report("?days=all");
    expect(all).toMatchObject({ app: "Bills", type: "Bill", days: null, from: null, count: 6, page: { label: "Bill report", date: { field: "due", label: "Due" } } });
    expect(all.tiles).toEqual([
      { label: "Bills", sums: { "": 6 }, share: null },
      { label: "Amount", sums: { BGN: 294.5, EUR: 12.99 }, share: null },
      { label: "Unpaid", sums: { BGN: 120.5, EUR: 12.99 }, share: null },
    ]);
    const [trend] = all.trends;
    expect(trend.series.map((s) => s.currency)).toEqual(["BGN", "EUR"]);
    expect(trend.series[0].points.slice(0, 3)).toEqual([
      { at: "2026-09-01T00:00:00.000Z", value: 40 },
      { at: "2026-10-01T00:00:00.000Z", value: 99 },
      { at: "2026-11-01T00:00:00.000Z", value: 150.5 },
    ]);
    expect(all.tables[0].rows.map((r) => [r.label, r.cells[0].sums[""], r.cells[1].sums])).toEqual([
      ["Electricity", 2, { BGN: 219.5 }],
      ["Netflix", 1, { EUR: 12.99 }],
      ["No date", 1, { BGN: 5 }],
      ["Old gym", 1, { BGN: 40 }],
      ["Water", 1, { BGN: 30 }],
    ]);
    // Left out: the page's first period.
    expect(await report()).toMatchObject({ days: 30 });
    await agent.get(`/api/apps/${appId}/reports/Bill?days=0`).expect(400);
    await agent.get(`/api/apps/${appId}/reports/Payee`).expect(404);
  });

  it("marks an App in the menu while none of its pipelines that run on their own is on; its page lists them", async () => {
    const pipeline = (name: string, trigger: string) => `
name: ${name}
app: Bills
trigger: ${trigger}
steps:
  - id: read
    type: data.read
    with: { type: Bill }
`;
    const create = async (source: string) => ((await agent.post("/api/pipelines").send({ source }).expect(201)).body as { pipelineId: string }).pipelineId;
    const menu = async () => ((await agent.get("/api/apps/menu").expect(200)).body as AppMenuItem[])[0]?.nothingOn;
    const app = async () => (await agent.get(`/api/apps/${appId}`).expect(200)).body as AppDetailView;

    // Started by hand: it runs when started, on or off; nothing to mark.
    await create(pipeline("Bills by hand", "manual"));
    expect(await menu()).toBe(false);

    const command = await create(pipeline("Bills on Telegram", '{ on: telegram.command, command: bills, description: "The bills due" }'));
    const daily = await create(pipeline("Bills every day", '{ schedule: "0 8 * * *" }'));
    expect(await menu()).toBe(true);
    expect((await app()).pipelines).toEqual([
      expect.objectContaining({ name: "Bills by hand", enabled: false, runsOnItsOwn: false, command: null }),
      expect.objectContaining({ name: "Bills every day", enabled: false, runsOnItsOwn: true, command: null }),
      expect.objectContaining({ name: "Bills on Telegram", enabled: false, runsOnItsOwn: true, command: "bills" }),
    ]);

    // One of them on: the App does something by itself; the page still lists the other.
    await agent.patch(`/api/pipelines/${command}`).send({ enabled: true }).expect(200);
    expect(await menu()).toBe(false);
    expect((await app()).pipelines.filter((p) => p.runsOnItsOwn && !p.enabled).map((p) => p.pipelineId)).toEqual([daily]);
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
    // The user's fields over what pipelines wrote.
    expect(view.rows[0]?.value).toMatchObject({ payee: "Water", paid: true });
  });

  it("filters, searches, pages and shows the removed apart", async () => {
    expect(keys(await list(`?filter=${encodeURIComponent('{"status":"due"}')}`))).toEqual(["e1", "n1"]);
    expect(keys(await list(`?filter=${encodeURIComponent('{"paid":"true"}')}`))).toEqual(["w1"]);
    expect(keys(await list("?q=electric"))).toEqual(["e1", "e0"]);
    // M65-T1: a list of text searched by default; one value saved before reads as a one-item list.
    expect(keys(await list("?q=UTILIT"))).toEqual(["e1"]);
    const streaming = await list("?q=stream");
    expect(streaming.rows.map((r) => [r.key, r.value.labels])).toEqual([["n1", ["streaming"]]]);
    const paged = await list("?offset=1&limit=2");
    expect([keys(paged), paged.total, paged.groups?.length]).toEqual([["e1", "n1"], 5, 3]);
    expect(keys(await list("?tab=removed"))).toEqual(["old"]);
    await agent.get(`/api/apps/${appId}/pages/Bill?filter=${encodeURIComponent('{"payee":"Water"}')}`).expect(400);
    await agent.get(`/api/apps/${appId}/pages/Bill?filter=nope`).expect(400);
    await agent.get(`/api/apps/${appId}/pages/Invoice`).expect(404);
  });

  // M65-I2: sources (distinct values with counts, items) and filters by type, together with search.
  it("returns its sources, and filters by a list's values, a day or a range, several values as any", async () => {
    await db.client.dataEntity.createMany({ data: [{ appId, type: "Payee", key: "Water", value: { name: "Water" } }, { appId, type: "Payee", key: "Acme", value: { name: "Acme" } }] });
    const view = await list();
    expect(view.sources).toEqual({
      labels: { kind: "values", field: "labels", values: [{ value: "Home", label: "Home", count: 1 }, { value: "streaming", label: "streaming", count: 1 }, { value: "utilities", label: "utilities", count: 1 }] },
      days: {
        kind: "values",
        field: "due",
        values: [
          { value: "2026-10-10", label: "2026-10-10", count: 1 },
          { value: "2026-11-05", label: "2026-11-05", count: 1 },
          { value: "2026-11-10", label: "2026-11-10", count: 1 },
          { value: "2026-11-20", label: "2026-11-20", count: 1 },
        ],
      },
      payees: { kind: "items", items: [{ id: "Acme", label: "Acme" }, { id: "Water", label: "Water" }] },
      unpaid: { kind: "items", items: [{ id: "e1", label: "Electricity" }, { id: "n1", label: "Netflix" }] },
    });
    // A list's filter picks among the values in use.
    expect(view.page.filters.find((f) => f.field === "labels")).toMatchObject({ match: "contains", values: [{ value: "Home" }, { value: "streaming" }, { value: "utilities" }] });
    const filtered = (filter: Record<string, unknown>, more = "") => list(`?filter=${encodeURIComponent(JSON.stringify(filter))}${more}`);
    expect(keys(await filtered({ labels: "HOME" }))).toEqual(["e1"]);
    expect(keys(await filtered({ labels: ["home", "streaming"] }))).toEqual(["e1", "n1"]);
    expect(keys(await filtered({ due: "2026-11-10" }))).toEqual(["e1"]);
    expect(keys(await filtered({ due: "2026-11-01..2026-11-15" }))).toEqual(["e1", "n1"]);
    expect(keys(await filtered({ due: "..2026-10-31" }))).toEqual(["e0"]);
    expect(keys(await filtered({ status: ["paid", "due"], due: "2026-11-01.." }))).toEqual(["w1", "e1", "n1"]);
    expect(keys(await filtered({ due: "2026-11-01..", status: "due" }, "&q=netf"))).toEqual(["n1"]);
    // On the page's own type, a source counts what the other filters leave; its own field's filter doesn't narrow it.
    const narrowed = await filtered({ status: "due", due: "2026-11-05" });
    expect(narrowed.sources.labels).toMatchObject({ values: [{ value: "streaming", count: 1 }] });
    expect(narrowed.sources.days).toMatchObject({ values: [{ value: "2026-11-05" }, { value: "2026-11-10" }] });
    await agent.get(`/api/apps/${appId}/pages/Bill?filter=${encodeURIComponent('{"due":"yesterday"}')}`).expect(400);
  });

  it("an entity's page: its fields as the view says, its history by its key", async () => {
    const view = (await agent.get(`/api/apps/${appId}/pages/Bill/e1`).expect(200)).body as AppEntityView;
    expect(view).toMatchObject({ app: "Bills", type: "Bill", list: { label: "My bills", title: "payee" }, row: { key: "e1" } });
    expect(view.page.sections[0]?.fields.map((f) => f.field)).toEqual(["id", "payee", "amount", "currency", "due", "status", "paid", "labels"]);
    expect(view.history?.map((p) => p.value)).toEqual([110, 120.5]);
    await agent.get(`/api/apps/${appId}/pages/Bill/nope`).expect(404);
  });
});

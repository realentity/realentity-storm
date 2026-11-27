import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { type AppDetailView, type AppEntityView, type AppListView, type AppUseChoiceView, type AppUseView } from "@realentity/storm-shared";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

/** An App that keeps bills, named by their issuer; `name` and `type` to make another one. */
const BILLS = (name = "Bills", type = "Bill") => `
name: ${name}
types:
  ${type}:
    key: billKey
    title: issuer
    fields:
      billKey: { type: text }
      issuer: { type: text }
      amount: { type: money }
      dueDate: { type: date }
      account: { type: text }
`;

/** An App of my expenses, each pointing at one of my bills (another App's), its list with sources of them. */
const EXPENSES = (fields = "[billKey, issuer, dueDate]") => `
name: Expenses
types:
  Expense:
    key: id
    mine: true
    fields:
      id: { type: text }
      note: { type: text }
      bill: { type: ref, to: Bill }
uses:
  Bill:
    from: { app: Bills, type: Bill }
    fields: ${fields}
pages:
  - list: Expense
    filters: [bill]
    sources:
      bills: { from: Bill, sort: dueDate }
      issuers: { from: Bill, distinct: issuer }
      days: { from: Bill, distinct: dueDate, by: day }
`;

// M66-T3 (the pages' half), I2, S1: a page's sources and refs read a use from the App chosen for it, its declared fields only
describe("pages through a use (M66)", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;
  let bills: string;
  let expenses: string;

  beforeAll(async () => {
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
  });

  const install = async (source: string) => ((await agent.post("/api/apps").send({ source }).expect(201)).body as AppDetailView).appId;
  const bill = (appId: string, key: string, value: Record<string, string | number>, removed = false) =>
    db.client.dataEntity.create({ data: { appId, type: "Bill", key, value: { billKey: key, ...value }, ...(removed ? { removedAt: new Date() } : {}) } });
  const list = async () => (await agent.get(`/api/apps/${expenses}/pages/Expense`).expect(200)).body as AppListView;
  const choices = async () => (await agent.get(`/api/apps/${expenses}/uses/Bill/choices`).expect(200)).body as AppUseChoiceView[];
  const add = (values: Record<string, unknown>) => agent.post(`/api/apps/${expenses}/pages/Expense`).send({ values });

  beforeEach(async () => {
    bills = await install(BILLS());
    expenses = await install(EXPENSES());
    await bill(bills, "power-11", { issuer: "Power Co", amount: 82.4, dueDate: "2026-11-20", account: "BG00 1111" });
    await bill(bills, "water-11", { issuer: "Water Co", amount: 21, dueDate: "2026-11-25", account: "BG00 2222" });
    await bill(bills, "gas-10", { issuer: "Gas Co", amount: 40, dueDate: "2026-10-01" }, true);
  });

  afterEach(async () => {
    await db.client.app.deleteMany();
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  it("a ref's choices, its filter's values and its sources are the chosen App's, by key and title, the removed left out", async () => {
    expect(await choices()).toEqual([
      { value: "power-11", label: "Power Co" },
      { value: "water-11", label: "Water Co" },
    ]);
    const view = await list();
    expect(view.page.filters.find((f) => f.field === "bill")).toMatchObject({ ref: "Bill", values: await choices() });
    expect(view.sources).toEqual({
      bills: { kind: "items", items: [{ id: "power-11", label: "Power Co" }, { id: "water-11", label: "Water Co" }] },
      issuers: { kind: "values", field: "issuer", values: [{ value: "Power Co", label: "Power Co", count: 1 }, { value: "Water Co", label: "Water Co", count: 1 }] },
      days: { kind: "values", field: "dueDate", values: [{ value: "2026-11-20", label: "2026-11-20", count: 1 }, { value: "2026-11-25", label: "2026-11-25", count: 1 }] },
    });
    // Never what it didn't declare: the amount, the account.
    expect(JSON.stringify(view)).not.toMatch(/BG00|82\.4/);
    await agent.get(`/api/apps/${expenses}/uses/Invoice/choices`).expect(404);
  });

  it("an expense saved pointing at a bill: named by it in the list and on its page, filtered by it; a bill not there refused", async () => {
    const created = (await add({ id: "e1", note: "Paid at the post office", bill: "power-11" }).expect(201)).body as AppEntityView;
    expect(created.row.titles).toEqual({ bill: "Power Co" });
    await add({ id: "e2", note: "Unknown", bill: "rent-11" }).expect(400);
    const removed = (await add({ id: "e3", bill: "gas-10" }).expect(400)).body as { errors: { path: string; message: string }[] };
    expect(removed.errors).toEqual([{ path: "bill", message: "isn't one of the Bills" }]);
    await add({ id: "e4", note: "Water", bill: "water-11" }).expect(201);

    const view = await list();
    expect(view.rows.map((r) => [r.key, r.titles?.bill])).toEqual(
      expect.arrayContaining([
        ["e1", "Power Co"],
        ["e4", "Water Co"],
      ]),
    );
    const filtered = (await agent.get(`/api/apps/${expenses}/pages/Expense?filter=${encodeURIComponent('{"bill":"water-11"}')}`).expect(200)).body as AppListView;
    expect(filtered.rows.map((r) => r.key)).toEqual(["e4"]);
    const page = (await agent.get(`/api/apps/${expenses}/pages/Expense/e1`).expect(200)).body as AppEntityView;
    expect(page.row.titles).toEqual({ bill: "Power Co" });
    expect(page.page.form.find((f) => f.field === "bill")).toMatchObject({ ref: "Bill", use: true });

    // Changed on its page: checked the same way.
    await agent.put(`/api/apps/${expenses}/pages/Expense/e1/values`).send({ values: { bill: "water-11" } }).expect(200);
    await agent.put(`/api/apps/${expenses}/pages/Expense/e1/values`).send({ values: { bill: "gas-10" } }).expect(400);
  });

  it("not chosen: no choices, no sources, a saved ref shown by its key, a new one refused saying where to choose it", async () => {
    await add({ id: "e1", bill: "power-11" }).expect(201);
    await agent.put(`/api/apps/${expenses}/uses`).send({ Bill: null }).expect(200);
    expect(await choices()).toEqual([]);
    const view = await list();
    expect(view.sources).toEqual({ bills: { kind: "items", items: [] }, issuers: { kind: "values", field: "issuer", values: [] }, days: { kind: "values", field: "dueDate", values: [] } });
    expect(view.rows[0]).toMatchObject({ key: "e1", value: expect.objectContaining({ bill: "power-11" }) as unknown });
    expect(view.rows[0].titles).toBeUndefined();
    expect(view.page.filters.find((f) => f.field === "bill")?.values).toEqual([]);
    const refused = (await add({ id: "e2", bill: "power-11" }).expect(400)).body as { errors: { path: string; message: string }[] };
    expect(refused.errors).toEqual([{ path: "bill", message: "Bill isn't chosen yet: choose which of your Apps it comes from, on Expenses's page" }]);
  });

  it("pointed at another App's type of another name: its entities, not the first App's", async () => {
    const household = await install(BILLS("Household", "Payment"));
    await db.client.dataEntity.create({ data: { appId: household, type: "Payment", key: "rent-11", value: { billKey: "rent-11", issuer: "Landlord", dueDate: "2026-11-01" } } });
    await agent.put(`/api/apps/${expenses}/uses`).send({ Bill: { appId: household, type: "Payment" } }).expect(200);
    expect(await choices()).toEqual([{ value: "rent-11", label: "Landlord" }]);
    await add({ id: "e1", bill: "rent-11" }).expect(201);
    await add({ id: "e2", bill: "power-11" }).expect(400);
    expect((await list()).sources.bills).toEqual({ kind: "items", items: [{ id: "rent-11", label: "Landlord" }] });
  });

  it("a use a ref points at needs the key and title among its fields: without them a type doesn't fit, and isn't read", async () => {
    await agent.put(`/api/apps/${expenses}`).send({ source: EXPENSES("[issuer, dueDate]") }).expect(200);
    const uses = (await agent.get(`/api/apps/${expenses}/uses`).expect(200)).body as AppUseView[];
    expect(uses).toEqual([
      expect.objectContaining({ source: expect.objectContaining({ app: "Bills" }) as unknown, problems: ["its key billKey isn't among the fields read (a ref holds it)"], fits: [] }),
    ]);
    expect(await choices()).toEqual([]);
    expect((await list()).sources.bills).toEqual({ kind: "items", items: [] });
    const refused = (await agent.put(`/api/apps/${expenses}/uses`).send({ Bill: { appId: bills, type: "Bill" } }).expect(400)).body as { errors: unknown[] };
    expect(refused.errors).toEqual([{ path: "Bill", message: "Bills › Bill doesn't fit: its key billKey isn't among the fields read (a ref holds it)" }]);

    await agent.put(`/api/apps/${expenses}`).send({ source: EXPENSES("[billKey, dueDate]").replace(/ {6}issuers:[^\n]*\n/, "") }).expect(200);
    expect(((await agent.get(`/api/apps/${expenses}/uses`).expect(200)).body as AppUseView[])[0].problems).toEqual(["its title issuer isn't among the fields read (a ref shows it)"]);
  });

  it("a chosen type without a title is named by its key; an entity without its title, by its key too", async () => {
    const plain = await install(BILLS("Plain", "Payment").replace("    title: issuer\n", ""));
    await db.client.dataEntity.createMany({
      data: [
        { appId: plain, type: "Payment", key: "rent-11", value: { billKey: "rent-11", issuer: "Landlord" } },
        { appId: plain, type: "Payment", key: "misc-11", value: { billKey: "misc-11" } },
      ],
    });
    await agent.put(`/api/apps/${expenses}/uses`).send({ Bill: { appId: plain, type: "Payment" } }).expect(200);
    expect(await choices()).toEqual([
      { value: "misc-11", label: "misc-11" },
      { value: "rent-11", label: "rent-11" },
    ]);
    await agent.put(`/api/apps/${expenses}/uses`).send({ Bill: { appId: bills, type: "Bill" } }).expect(200);
    await bill(bills, "misc-11", { amount: 1 });
    expect((await choices()).map((c) => c.label)).toEqual(["misc-11", "Power Co", "Water Co"]);
  });

  it("a draft's preview: sources of its own types from the rows shown, of a use none (nothing is read for a draft)", async () => {
    const source = EXPENSES().replace("    sources:\n", "    sources:\n      notes: { from: Expense, distinct: note }\n      mine: { from: Expense }\n");
    await add({ id: "e1", note: "Taxi", bill: "power-11" }).expect(201);
    const preview = (await agent.post("/api/apps/preview").send({ source, type: "Expense", appId: expenses }).expect(200)).body as { list: AppListView };
    expect(preview.list.sources.bills).toEqual({ kind: "items", items: [] });
    expect(preview.list.sources.notes).toEqual({ kind: "values", field: "note", values: [{ value: "Taxi", label: "Taxi", count: 1 }] });
    expect(preview.list.sources.mine).toEqual({ kind: "items", items: [{ id: "e1", label: "e1" }] });
  });

  it("another user's App chosen for it reads nothing", async () => {
    const other = await db.client.user.create({ data: { email: `other-${Date.now()}@storm.test` } });
    const theirs = await db.client.app.create({ data: { userId: other.userId, name: "Bills" } });
    const version = await db.client.appVersion.create({ data: { appId: theirs.appId, version: 1, definition: {}, source: BILLS() } });
    await db.client.app.update({ where: { appId: theirs.appId }, data: { currentVersionId: version.appVersionId } });
    await bill(theirs.appId, "theirs-11", { issuer: "Their Co" });
    await db.client.appUse.update({ where: { appId_name: { appId: expenses, name: "Bill" } }, data: { sourceAppId: theirs.appId } });
    expect(await choices()).toEqual([]);
    await add({ id: "e1", bill: "theirs-11" }).expect(400);
    await db.client.user.delete({ where: { userId: other.userId } });
  });
});

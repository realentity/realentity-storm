import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { type AppCheckView, type AppDetailView, type AppMapView, type AppUseView, type ChecklistView } from "@realentity/storm-shared";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

/** An App that keeps bills; `extra`: more of its Bill's fields. */
const BILLS = (name: string, extra = "") => `
name: ${name}
types:
  Bill:
    key: billKey
    fields:
      billKey: { type: text }
      issuer: { type: text }
      amount: { type: money }
      dueDate: { type: date }
      note: { type: longtext, encrypted: true }${extra}
`;

/** An App that reads another App's bills, under the name Bill. */
const REPORT = (name = "Report", fields = "[issuer, amount, dueDate]") => `
name: ${name}
types:
  Expense:
    key: id
    fields: { id: { type: text }, total: { type: money } }
uses:
  Bill:
    from: { app: Bills, type: Bill }
    fields: ${fields}
    help: Your bills, for the monthly expense report
`;

// M66-T1, T2 (the api's half): a use of another App's type, filled by one of my Apps by id; only what fits
describe("an App's uses of other Apps' types (M66)", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;

  beforeAll(async () => {
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
  });

  afterEach(async () => {
    await db.client.app.deleteMany();
  });

  afterAll(async () => {
    await db.close();
    await api.close();
  });

  const install = async (source: string) => ((await agent.post("/api/apps").send({ source }).expect(201)).body as AppDetailView).appId;
  const uses = async (appId: string) => (await agent.get(`/api/apps/${appId}/uses`).expect(200)).body as AppUseView[];
  const filled = async (appId: string) => Object.fromEntries((await uses(appId)).map((u) => [u.name, u.source && `${u.source.app} › ${u.source.type}`]));

  it("is filled by the App and type it names, installed before or after it; the others that fit are offered", async () => {
    // The report first: nothing to fill it yet.
    const report = await install(REPORT());
    expect(await uses(report)).toEqual([
      expect.objectContaining({ name: "Bill", source: null, problems: [], fits: [], use: expect.objectContaining({ help: "Your bills, for the monthly expense report" }) as unknown }),
    ]);
    // Bills installed after: filled by name. Another App with a Bill that fits is offered, not chosen.
    const bills = await install(BILLS("Bills"));
    const home = await install(BILLS("Home bills"));
    expect(await filled(report)).toEqual({ Bill: "Bills › Bill" });
    expect((await uses(report))[0].fits.map((f) => `${f.app} › ${f.type}`)).toEqual(["Bills › Bill", "Home bills › Bill"]);

    // Chosen by id: a rename of the App it comes from keeps it.
    await agent.put(`/api/apps/${report}/uses`).send({ Bill: { appId: home, type: "Bill" } }).expect(200);
    await agent.put(`/api/apps/${home}`).send({ source: BILLS("Household") }).expect(200);
    expect(await filled(report)).toEqual({ Bill: "Household › Bill" });
    await agent.put(`/api/apps/${report}/uses`).send({ Bill: null }).expect(200);
    expect(await filled(report)).toEqual({ Bill: null });

    // Cleared on purpose: saving the report, the App it names or another App never fills it again behind my back.
    await agent.put(`/api/apps/${report}`).send({ source: REPORT().replace("total: { type: money }", "total: { type: money }, month: { type: text }") }).expect(200);
    await agent.put(`/api/apps/${bills}`).send({ source: BILLS("Bills", "\n      vat: { type: money }") }).expect(200);
    await install(BILLS("Office bills"));
    expect(await filled(report)).toEqual({ Bill: null });
  });

  it("filled when the App it names starts to fit: renamed to that name, or given the fields; a new use of an App, at its save", async () => {
    const report = await install(REPORT());
    const old = await install(BILLS("Old bills"));
    expect(await filled(report)).toEqual({ Bill: null });
    await agent.put(`/api/apps/${old}`).send({ source: BILLS("Bills") }).expect(200);
    expect(await filled(report)).toEqual({ Bill: "Bills › Bill" });

    // A use added to an App already installed: filled at that save.
    const notes = await install(REPORT("Notes").replace(/uses:[\s\S]*$/, ""));
    expect(await uses(notes)).toEqual([]);
    await agent.put(`/api/apps/${notes}`).send({ source: REPORT("Notes") }).expect(200);
    expect(await filled(notes)).toEqual({ Bill: "Bills › Bill" });
  });

  // M66-S1 (this branch's half): another user's App's uses are neither read nor set
  it("another user's App: its uses not found, nor set", async () => {
    const other = await db.client.user.create({ data: { email: `other-${Date.now()}@storm.test` } });
    const theirs = await db.client.app.create({ data: { userId: other.userId, name: "Theirs" } });
    const version = await db.client.appVersion.create({ data: { appId: theirs.appId, version: 1, definition: {}, source: REPORT("Theirs") } });
    await db.client.app.update({ where: { appId: theirs.appId }, data: { currentVersionId: version.appVersionId } });
    const bills = await install(BILLS("Bills"));
    await agent.get(`/api/apps/${theirs.appId}/uses`).expect(404);
    await agent.put(`/api/apps/${theirs.appId}/uses`).send({ Bill: { appId: bills, type: "Bill" } }).expect(404);
    // And installing my Bills doesn't fill their use.
    expect(await db.client.appUse.count({ where: { appId: theirs.appId } })).toBe(0);
    await db.client.user.delete({ where: { userId: other.userId } });
  });

  it("a choice made stays: the App it names installed later doesn't take it; the chosen type renamed away: said so; a type that isn't there: refused", async () => {
    const household = await install(BILLS("Household").replace("  Bill:", "  Payment:"));
    const report = await install(REPORT());
    await agent.put(`/api/apps/${report}/uses`).send({ Bill: { appId: household, type: "Payment" } }).expect(200);
    await install(BILLS("Bills"));
    expect(await filled(report)).toEqual({ Bill: "Household › Payment" });

    // Two types of one App that fit: offered by name, the App named first.
    await agent.put(`/api/apps/${household}`).send({ source: BILLS("Household").replace("  Bill:", "  Payment:") + BILLS("x").replace(/^[\s\S]*types:\n/, "").replace("  Bill:", "  Invoice:") }).expect(200);
    expect((await uses(report))[0].fits.map((f) => `${f.app} › ${f.type}`)).toEqual(["Bills › Bill", "Household › Invoice", "Household › Payment"]);

    await agent.put(`/api/apps/${household}`).send({ source: BILLS("Household").replace("  Bill:", "  Invoice:") }).expect(200);
    expect(await uses(report)).toEqual([expect.objectContaining({ source: expect.objectContaining({ type: "Payment" }) as unknown, problems: ["Household has no type Payment any more"] })]);
    const refused = (await agent.put(`/api/apps/${report}/uses`).send({ Bill: { appId: household, type: "Payment" } }).expect(400)).body as { errors: unknown[] };
    expect(refused.errors).toEqual([{ path: "Bill", message: "Household has no type Payment" }]);
  });

  it("two Apps of the name it gives, or one named otherwise: waits for my choice", async () => {
    await install(BILLS("Home bills"));
    const report = await install(REPORT());
    expect(await filled(report)).toEqual({ Bill: null });
    expect((await uses(report))[0].fits.map((f) => f.app)).toEqual(["Home bills"]);
  });

  it("refuses what doesn't fit: a missing or encrypted field, its own type, another user's App, a name that isn't a use", async () => {
    const bills = await install(BILLS("Bills"));
    const notes = await install(REPORT("Notes", "[issuer, note]"));
    const short = await install(REPORT("Short", "[issuer, vat]"));
    const report = await install(REPORT());
    expect(await filled(notes)).toEqual({ Bill: null });
    expect(await filled(short)).toEqual({ Bill: null });

    const refused = async (appId: string, body: object) =>
      ((await agent.put(`/api/apps/${appId}/uses`).send(body).expect(400)).body as { errors: { path: string; message: string }[] }).errors;
    expect(await refused(notes, { Bill: { appId: bills, type: "Bill" } })).toEqual([{ path: "Bill", message: "Bills › Bill doesn't fit: note is encrypted" }]);
    expect(await refused(short, { Bill: { appId: bills, type: "Bill" } })).toEqual([{ path: "Bill", message: 'Bills › Bill doesn\'t fit: it has no field "vat"' }]);
    expect(await refused(report, { Bill: { appId: report, type: "Expense" } })).toEqual([{ path: "Bill", message: "an App's own types aren't a use: use them directly" }]);
    expect(await refused(report, { Bills: { appId: bills, type: "Bill" } })).toEqual([{ path: "Bills", message: "isn't one of its uses" }]);

    // Another user's App: not found, as if it weren't there.
    const other = await db.client.user.create({ data: { email: `other-${Date.now()}@storm.test` } });
    const theirs = await db.client.app.create({ data: { userId: other.userId, name: "Bills" } });
    expect(await refused(report, { Bill: { appId: theirs.appId, type: "Bill" } })).toEqual([{ path: "Bill", message: "no such App" }]);
    await db.client.user.delete({ where: { userId: other.userId } });
  });

  it("a field the owner removes later: still chosen, said to no longer fit; the owner deleted: let go; a use removed from the YAML: let go", async () => {
    const bills = await install(BILLS("Bills"));
    const report = await install(REPORT());
    expect(await filled(report)).toEqual({ Bill: "Bills › Bill" });

    await agent.put(`/api/apps/${bills}`).send({ source: BILLS("Bills").replace("      dueDate: { type: date }\n", "") }).expect(200);
    expect(await uses(report)).toEqual([expect.objectContaining({ source: expect.objectContaining({ app: "Bills" }) as unknown, problems: ['it has no field "dueDate"'] })]);

    await agent.put(`/api/apps/${report}`).send({ source: REPORT().replace(/uses:[\s\S]*$/, "") }).expect(200);
    expect(await db.client.appUse.count({ where: { appId: report } })).toBe(0);

    const again = await install(REPORT("Again"));
    await agent.put(`/api/apps/${bills}`).send({ source: BILLS("Bills") }).expect(200);
    await agent.put(`/api/apps/${again}/uses`).send({ Bill: { appId: bills, type: "Bill" } }).expect(200);
    await agent.delete(`/api/apps/${bills}`).expect(204);
    expect(await filled(again)).toEqual({ Bill: null });

    // Pointed elsewhere after: another App, its type named otherwise, offered and chosen.
    const household = await install(BILLS("Household").replace("  Bill:", "  Payment:"));
    expect(await filled(again)).toEqual({ Bill: null });
    expect((await uses(again))[0].fits).toEqual([{ appId: household, app: "Household", type: "Payment" }]);
    await agent.put(`/api/apps/${again}/uses`).send({ Bill: { appId: household, type: "Payment" } }).expect(200);
    expect(await uses(again)).toEqual([expect.objectContaining({ source: { appId: household, app: "Household", type: "Payment" }, problems: [] })]);
  });

  // M66-T6: a use that targets a field (mine:) is filled only by a type where I typed it
  it("mine: is filled only where the field is mine; elsewhere not offered, and refused", async () => {
    const bills = await install(BILLS("Bills"));
    const mine = REPORT("Mine", "[issuer]").replace("    help:", "    mine: [issuer]\n    help:");
    const report = await install(mine);
    expect(await filled(report)).toEqual({ Bill: null });
    expect((await uses(report))[0].fits).toEqual([]);
    const refused = (await agent.put(`/api/apps/${report}/uses`).send({ Bill: { appId: bills, type: "Bill" } }).expect(400)).body as { errors: unknown[] };
    expect(refused.errors).toEqual([{ path: "Bill", message: "Bills › Bill doesn't fit: issuer isn't a field of mine there (typed by me)" }]);

    // The owner keeps it as mine: fills it, by the name it gives.
    await agent.put(`/api/apps/${bills}`).send({ source: BILLS("Bills").replace("issuer: { type: text }", "issuer: { type: text, mine: true }") }).expect(200);
    expect(await filled(report)).toEqual({ Bill: "Bills › Bill" });
    // And the owner's check says before it stops being mine.
    const check = (await agent.post("/api/apps/check").send({ source: BILLS("Bills"), appId: bills }).expect(201)).body as AppCheckView;
    expect(check.usedBy.map((u) => u.problems)).toEqual([["issuer isn't a field of mine there (typed by me)"]]);
  });

  // M66-T4: the owner's side
  it("the owner lists the Apps that read it; its draft's check names the uses it would no longer fit, and why; the map draws a use", async () => {
    const bills = await install(BILLS("Bills"));
    const report = await install(REPORT());
    const notes = await install(REPORT("Notes", "[issuer]"));
    const detail = (await agent.get(`/api/apps/${bills}`).expect(200)).body as AppDetailView;
    expect(detail.usedBy).toEqual([
      { appId: notes, app: "Notes", use: "Bill", type: "Bill", fields: ["issuer"] },
      { appId: report, app: "Report", use: "Bill", type: "Bill", fields: ["issuer", "amount", "dueDate"] },
    ]);
    expect(((await agent.get(`/api/apps/${report}`).expect(200)).body as AppDetailView).usedBy).toEqual([]);

    const check = async (source: string) => ((await agent.post("/api/apps/check").send({ source, appId: bills }).expect(201)).body as AppCheckView).usedBy;
    // A change they don't read: nothing to say.
    expect(await check(BILLS("Bills", "\n      vat: { type: money }"))).toEqual([]);
    expect(await check(BILLS("Bills").replace("      dueDate: { type: date }\n", ""))).toEqual([
      { appId: report, app: "Report", use: "Bill", type: "Bill", fields: ["issuer", "amount", "dueDate"], problems: ['it has no field "dueDate"'] },
    ]);
    expect((await check(BILLS("Bills").replace("issuer: { type: text }", "issuer: { type: text, encrypted: true }"))).map((u) => [u.app, u.problems])).toEqual([
      ["Notes", ["issuer is encrypted"]],
      ["Report", ["issuer is encrypted"]],
    ]);
    expect((await check(BILLS("Bills").replace("  Bill:", "  Invoice:"))).map((u) => [u.app, u.problems])).toEqual([
      ["Notes", ["it would have no type Bill"]],
      ["Report", ["it would have no type Bill"]],
    ]);
    // A new App's draft: no one reads it yet.
    expect(((await agent.post("/api/apps/check").send({ source: BILLS("Other bills") }).expect(201)).body as AppCheckView).usedBy).toEqual([]);

    // Saved anyway: the App that reads it shows the use needs attention.
    await agent.put(`/api/apps/${bills}`).send({ source: BILLS("Bills").replace("  Bill:", "  Invoice:") }).expect(200);
    expect((await uses(report))[0].problems).toEqual(["Bills has no type Bill any more"]);

    const map = (await agent.get(`/api/apps/${report}/map`).expect(200)).body as AppMapView;
    expect(map.uses).toEqual([{ id: "use:Bill", use: "Bill", label: "Bill", detail: "from Bills › Bill" }]);
  });

  it("an App installed from an example lists each use on its checklist until it is filled", async () => {
    const report = await install(REPORT());
    await db.client.app.update({ where: { appId: report }, data: { example: { id: "report", needs: [] } } });
    const item = async () =>
      ((await agent.get(`/api/examples/apps/${report}/checklist`).expect(200)).body as ChecklistView).items.find((i) => i.label.startsWith('Choose where "Bill"'));
    expect(await item()).toEqual({ label: 'Choose where "Bill" comes from: Your bills, for the monthly expense report', done: false, link: `/apps/${report}#uses` });
    const bills = await install(BILLS("Bills"));
    expect(await item()).toMatchObject({ done: true });
    await agent.put(`/api/apps/${bills}`).send({ source: BILLS("Bills").replace("      amount: { type: money }\n", "") }).expect(200);
    expect(await item()).toMatchObject({ done: false, note: 'Bills › Bill no longer fits: it has no field "amount"' });
  });

  it("an optional use doesn't hold the checklist back until it is chosen and stops fitting", async () => {
    const report = await install(REPORT().replace("    help:", "    optional: true\n    help:"));
    await db.client.app.update({ where: { appId: report }, data: { example: { id: "report", needs: [] } } });
    const item = async () =>
      ((await agent.get(`/api/examples/apps/${report}/checklist`).expect(200)).body as ChecklistView).items.find((i) => i.label.startsWith('Choose where "Bill"'));
    expect(await item()).toEqual({ label: 'Choose where "Bill" comes from: Your bills, for the monthly expense report (optional)', done: true, link: `/apps/${report}#uses` });
    const bills = await install(BILLS("Bills"));
    expect(await item()).toMatchObject({ done: true });
    await agent.put(`/api/apps/${bills}`).send({ source: BILLS("Bills").replace("      amount: { type: money }\n", "") }).expect(200);
    expect(await item()).toMatchObject({ done: false });

    // Without help: just where it comes from.
    const plain = await install(REPORT("Plain").replace(/ {4}help:.*\n/,"    optional: true\n"));
    await db.client.app.update({ where: { appId: plain }, data: { example: { id: "plain", needs: [] } } });
    const items = ((await agent.get(`/api/examples/apps/${plain}/checklist`).expect(200)).body as ChecklistView).items;
    expect(items.filter((i) => i.label.startsWith("Choose where"))).toEqual([{ label: 'Choose where "Bill" comes from (optional)', done: true, link: `/apps/${plain}#uses` }]);
  });
});

import { payloadHash } from "@realentity/storm-crypto";
import { createPrismaConnection, type Prisma, type PrismaConnection } from "@realentity/storm-db";
import { readAppSource } from "@realentity/storm-shared";
import { TestEnvironment } from "@realentity/storm-testing";
import { defaultCatalog, PipelineCompiler } from "@realentity/storm-steps";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry, NO_ATTENTION, type StepContext } from "../src/runner/step-executor";
import { SaveStep } from "../src/steps/data-steps";
import { ReadStep } from "../src/steps/entity-steps";
import { MapStep } from "../src/steps/map-alert-steps";
import { type MailConnector, type OutgoingMail } from "../src/mail/mail-connector";
import { EmailSendStep } from "../src/steps/email-steps";
import { catalog, createVersion } from "./support/test-steps";

const BILLS = `
name: Bills
types:
  Bill:
    key: billKey
    stages:
      field: status
      initial: due
      states: [due, paid]
      moves: [{ from: due, to: [paid] }]
    fields:
      billKey: { type: text }
      issuer: { type: text }
      amount: { type: money }
      dueDate: { type: date }
      account: { type: text }
      note: { type: longtext, mine: true }
      secret: { type: longtext, encrypted: true }
`;

const REPORT = `
name: Report
types:
  Expense:
    key: id
    fields: { id: { type: text } }
uses:
  Bill:
    from: { app: Bills, type: Bill }
    fields: [issuer, amount, dueDate, status, note]
`;

// M66-I2, S1: data.read of a use reads the App chosen for it, only the declared fields; nothing else, never another's
describe("data.read through a use (M66)", () => {
  let db: PrismaConnection;
  let userId: string;
  let reportId: string;
  let billsId: string;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  /** An App of the user's with its current version. */
  const app = async (source: string, owner = userId) => {
    const row = await db.client.app.create({ data: { userId: owner, name: readAppSource(source).name } });
    const version = await db.client.appVersion.create({ data: { appId: row.appId, version: 1, definition: {}, source } });
    await db.client.app.update({ where: { appId: row.appId }, data: { currentVersionId: version.appVersionId } });
    return row.appId;
  };
  const bill = (appId: string, key: string, value: Record<string, string | number>, stage: string, mine: Record<string, string> = {}) =>
    db.client.dataEntity.create({ data: { appId, type: "Bill", key, value: { billKey: key, ...value }, mine, stage } });

  beforeEach(async () => {
    billsId = await app(BILLS);
    reportId = await app(REPORT);
    await bill(billsId, "power-11", { issuer: "Power Co", amount: 82.4, dueDate: "2026-11-20", account: "BG00 1111", secret: "sealed-not-read" }, "paid", { note: "Paid late" });
    await bill(billsId, "water-11", { issuer: "Water Co", amount: 21, dueDate: "2026-11-25", account: "BG00 2222" }, "due");
  });

  afterEach(async () => {
    await db.client.app.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  const context = (): StepContext => ({
    runId: "00000000-0000-4000-8000-000000000001",
    userId,
    pipelineId: "00000000-0000-4000-8000-000000000002",
    stepId: "s",
    stepKey: "k",
    itemIndex: null,
    dryRun: false,
    app: "Report",
    appId: reportId,
    recordUsage: () => undefined,
    attention: NO_ATTENTION,
  });
  const read = (input: Record<string, unknown> = {}) =>
    new ReadStep(db.client).execute(catalog.get("data.read")!.input.parse({ type: "Bill", ...input }), context()) as Promise<{
      items: Record<string, unknown>[];
      count: number;
    }>;
  const choose = (sourceAppId: string, sourceType = "Bill") =>
    db.client.appUse.create({ data: { appId: reportId, name: "Bill", sourceAppId, sourceType } });

  it("not chosen yet: refused, saying where to choose it; an optional use reads nothing instead, until it no longer fits", async () => {
    await expect(read()).rejects.toThrow("Bill isn't chosen yet: choose which of your Apps it comes from, on Report's page");
    const version = await db.client.appVersion.create({
      data: { appId: reportId, version: 2, definition: {}, source: REPORT.replace("fields: [issuer, amount, dueDate, status, note]", "fields: [issuer, amount]\n    optional: true") },
    });
    await db.client.app.update({ where: { appId: reportId }, data: { currentVersionId: version.appVersionId } });
    expect(await read()).toEqual({ items: [], count: 0 });
    // Chosen, then no longer fitting: a mistake to fix, so it stops.
    await choose(billsId);
    expect((await read()).count).toBe(2);
    const owner = await db.client.appVersion.create({ data: { appId: billsId, version: 2, definition: {}, source: BILLS.replace("      amount: { type: money }\n", "") } });
    await db.client.app.update({ where: { appId: billsId }, data: { currentVersionId: owner.appVersionId } });
    await expect(read()).rejects.toThrow('Bills › Bill no longer fits Bill: it has no field "amount"');
  });

  it("reads the chosen App's entities with only the declared fields, my fields and the stage among them", async () => {
    await choose(billsId);
    const { items, count } = await read({ sort: "dueDate" });
    expect(count).toBe(2);
    expect(items).toEqual([
      { issuer: "Power Co", amount: 82.4, dueDate: "2026-11-20", status: "paid", note: "Paid late" },
      { issuer: "Water Co", amount: 21, dueDate: "2026-11-25", status: "due" },
    ]);
    // Never what it didn't declare: the key, the account, an encrypted field.
    for (const item of items) for (const field of ["billKey", "account", "secret"]) expect(item).not.toHaveProperty(field);
    expect((await read({ where: [{ field: "status", op: "eq", value: "due" }] })).items.map((i) => i.issuer)).toEqual(["Water Co"]);
  });

  it("a dotted field at its path; sorted by when first seen; removed entities only when asked", async () => {
    const nested = BILLS.replace("      account: { type: text }\n", "      account: { type: text }\n      contact.email: { type: email }\n      contact.phone: { type: text }\n");
    const other = await app(nested.replace("name: Bills", "name: Nested bills"));
    await db.client.app.update({ where: { appId: reportId }, data: {} });
    const version = await db.client.appVersion.create({
      data: { appId: reportId, version: 2, definition: {}, source: REPORT.replace("fields: [issuer, amount, dueDate, status, note]", "fields: [issuer, contact.email]") },
    });
    await db.client.app.update({ where: { appId: reportId }, data: { currentVersionId: version.appVersionId } });
    await db.client.dataEntity.create({
      data: { appId: other, type: "Bill", key: "a", value: { billKey: "a", issuer: "First", contact: { email: "billing@first.example", phone: "0888" } }, firstSeenAt: new Date("2026-11-01") },
    });
    await db.client.dataEntity.create({ data: { appId: other, type: "Bill", key: "b", value: { billKey: "b", issuer: "Second" }, firstSeenAt: new Date("2026-11-02") } });
    await db.client.dataEntity.create({
      data: { appId: other, type: "Bill", key: "c", value: { billKey: "c", issuer: "Gone" }, removedAt: new Date("2026-11-03") },
    });
    await choose(other);

    expect((await read({ sort: "@firstSeen" })).items).toEqual([{ issuer: "First", contact: { email: "billing@first.example" } }, { issuer: "Second" }]);
    expect((await read({ sort: "-@lastSeen", limit: 1 })).count).toBe(2);
    expect((await read({ removed: true })).items).toEqual([{ issuer: "Gone" }]);
  });

  it("an App's own type as before: not a use, or no such type, or no App", async () => {
    await expect(read({ type: "Invoice" })).rejects.toThrow('"Report" has no type "Invoice"');
    expect((await read({ type: "Expense" })).items).toEqual([]);
    const outside = { ...context(), app: undefined, appId: undefined };
    await expect(new ReadStep(db.client).execute(catalog.get("data.read")!.input.parse({ type: "Bill" }), outside)).rejects.toThrow(
      "Bill is an App's type, and this pipeline has no app:",
    );
    await expect(new SaveStep(db.client).execute(catalog.get("data.save")!.input.parse({ type: "Invoice", items: [] }), context())).rejects.toThrow(
      '"Report" has no type "Invoice"',
    );
    const gone = { ...context(), app: "Gone", appId: "00000000-0000-4000-8000-00000000dead" };
    await expect(new ReadStep(db.client).execute(catalog.get("data.read")!.input.parse({ type: "Bill" }), gone)).rejects.toThrow('There is no App named "Gone"');
  });

  it("reads only the App chosen, not another App with the same name of type", async () => {
    const home = await app(BILLS.replace("name: Bills", "name: Home bills"));
    await bill(home, "rent-11", { issuer: "Landlord", amount: 600, dueDate: "2026-11-01" }, "due");
    await choose(home);
    expect((await read()).items.map((i) => i.issuer)).toEqual(["Landlord"]);
  });

  it("the chosen App deleted: not chosen any more; pointed at another App's type of another name, reads that", async () => {
    await choose(billsId);
    await db.client.app.delete({ where: { appId: billsId } });
    await expect(read()).rejects.toThrow("Bill isn't chosen yet");

    const home = await app(BILLS.replace("name: Bills", "name: Household").replace("  Bill:", "  Payment:"));
    await db.client.dataEntity.create({ data: { appId: home, type: "Payment", key: "rent-11", value: { billKey: "rent-11", issuer: "Landlord", amount: 600, dueDate: "2026-11-01" }, stage: "due" } });
    // Its other types' rows, with the same fields, aren't read.
    await db.client.dataEntity.create({ data: { appId: home, type: "Bill", key: "x", value: { billKey: "x", issuer: "Not this", amount: 1 }, stage: "due" } });
    await choose(home, "Payment");
    expect((await read()).items).toEqual([{ issuer: "Landlord", amount: 600, dueDate: "2026-11-01", status: "due" }]);
  });

  it("the chosen App no longer fits (a field removed, made encrypted) or its type gone: refused, nothing read", async () => {
    await choose(billsId);
    const change = async (source: string) => {
      const version = await db.client.appVersion.create({ data: { appId: billsId, version: 2 + (await db.client.appVersion.count({ where: { appId: billsId } })), definition: {}, source } });
      await db.client.app.update({ where: { appId: billsId }, data: { currentVersionId: version.appVersionId } });
    };
    await change(BILLS.replace("      dueDate: { type: date }\n", ""));
    await expect(read()).rejects.toThrow('Bills › Bill no longer fits Bill: it has no field "dueDate". Choose again on Report\'s page');
    await change(BILLS.replace("note: { type: longtext, mine: true }", "note: { type: longtext, mine: true, encrypted: true }"));
    await expect(read()).rejects.toThrow("Bills › Bill no longer fits Bill: note is encrypted");
    await change(BILLS.replace("  Bill:", "  Invoice:"));
    await expect(read()).rejects.toThrow("Bills › Bill no longer fits Bill: it has no type Bill any more");
  });

  it("a use a ref of the App points at, without the chosen type's key among its fields: doesn't fit, refused", async () => {
    await choose(billsId);
    const withRef = REPORT.replace("fields: { id: { type: text } }", "fields: { id: { type: text }, bill: { type: ref, to: Bill } }");
    const version = await db.client.appVersion.create({ data: { appId: reportId, version: 2, definition: {}, source: withRef } });
    await db.client.app.update({ where: { appId: reportId }, data: { currentVersionId: version.appVersionId } });
    await expect(read()).rejects.toThrow("Bills › Bill no longer fits Bill: its key billKey isn't among the fields read (a ref holds it)");
    const keyed = await db.client.appVersion.create({ data: { appId: reportId, version: 3, definition: {}, source: withRef.replace("fields: [issuer,", "fields: [billKey, issuer,") } });
    await db.client.app.update({ where: { appId: reportId }, data: { currentVersionId: keyed.appVersionId } });
    expect((await read()).items.map((i) => i.billKey)).toEqual(["water-11", "power-11"]);
  });

  // M66-T6: a field of mine there, listed under the use's mine:, is a recipient here; checked again at every run
  it("sends to a use's field of mine (mine:), as I typed it there; refused once the owner no longer keeps it as mine", async () => {
    const owner = await db.client.appVersion.create({
      data: { appId: billsId, version: 2, definition: {}, source: BILLS.replace("      note:", "      email: { type: email, mine: true }\n      note:") },
    });
    await db.client.app.update({ where: { appId: billsId }, data: { currentVersionId: owner.appVersionId } });
    await db.client.dataEntity.update({ where: { appId_type_key: { appId: billsId, type: "Bill", key: "power-11" } }, data: { mine: { note: "Paid late", email: "billing@power.example" } } });
    const reader = REPORT.replace("fields: [issuer, amount, dueDate, status, note]", "fields: [issuer, email]\n    mine: [email]");
    const version = await db.client.appVersion.create({ data: { appId: reportId, version: 2, definition: {}, source: reader } });
    await db.client.app.update({ where: { appId: reportId }, data: { currentVersionId: version.appVersionId } });
    await choose(billsId);

    const sent: OutgoingMail[] = [];
    const mail = {
      send: (_who: unknown, message: OutgoingMail) => (sent.push(message), Promise.resolve({ messageId: "<m1@example.com>", accepted: [message.to], from: "me@example.com" })),
    } as unknown as MailConnector;
    const versionId = await createVersion(
      db.client,
      userId,
      `name: Report · Ask
app: Report
steps:
  - id: bills
    type: data.read
    with: { type: Bill, where: [{ field: issuer, op: eq, value: Power Co }] }
  - id: ask
    type: email.send
    forEach: "{{bills.items}}"
    with: { to: "{{item.email}}", subject: "Your invoice", body: "Could you send me the invoice, please?" }
`,
      new PipelineCompiler(defaultCatalog()),
      { app: readAppSource(reader) },
    );
    const runner = new PipelineRunner(db.client, defaultCatalog(), new ExecutorRegistry([new ReadStep(db.client), new EmailSendStep(mail)]));
    const first = await runner.start(versionId, { trigger: "manual" });
    expect(await runner.advance(first)).toBe("WAITING_FOR_USER");
    const [proposal] = await db.client.proposal.findMany({ where: { runId: first } });
    const payload = proposal.originalPayload as Record<string, unknown>;
    expect(payload).toMatchObject({ to: "billing@power.example" });
    await db.client.proposal.update({ where: { proposalId: proposal.proposalId }, data: { status: "APPROVED", finalPayload: payload as Prisma.InputJsonValue, payloadHash: payloadHash(payload) } });
    expect(await runner.advance(first)).toBe("DONE");
    expect(sent.map((m) => m.to)).toEqual(["billing@power.example"]);

    // The owner keeps the address as written by pipelines now: the use no longer fits, nothing sent.
    const changed = await db.client.appVersion.create({
      data: { appId: billsId, version: 3, definition: {}, source: BILLS.replace("      note:", "      email: { type: email }\n      note:") },
    });
    await db.client.app.update({ where: { appId: billsId }, data: { currentVersionId: changed.appVersionId } });
    const runId = await runner.start(versionId, { trigger: "manual" });
    expect(await runner.advance(runId)).toBe("FAILED");
    const failed = await db.client.step.findFirstOrThrow({ where: { runId, stepKey: "bills" } });
    expect(failed.error).toContain("Bills › Bill no longer fits Bill: email isn't a field of mine there (typed by me)");
    expect(sent).toHaveLength(1);
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
  });

  it("a pipeline of the App compiled and run: its total from the other App's bills", async () => {
    await choose(billsId);
    const compiler = new PipelineCompiler(defaultCatalog());
    const versionId = await createVersion(
      db.client,
      userId,
      `name: Report · Month
app: Report
steps:
  - id: bills
    type: data.read
    with: { type: Bill, where: [{ field: dueDate, op: gte, value: "2026-11-01" }] }
  - id: total
    type: data.map
    with: { from: "{{bills.items}}", expression: "$sum(amount)" }
`,
      compiler,
      { app: readAppSource(REPORT) },
    );
    const runner = new PipelineRunner(db.client, defaultCatalog(), new ExecutorRegistry([new ReadStep(db.client), new MapStep()]));
    const runId = await runner.start(versionId, { trigger: "manual" });
    expect(await runner.advance(runId)).toBe("DONE");
    const total = await db.client.step.findFirstOrThrow({ where: { runId, stepKey: "total" } });
    expect(total.output).toMatchObject({ value: 103.4 });
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
  });

  it("a choice pointing at another user's App reads nothing", async () => {
    const other = await db.client.user.create({ data: { email: `other-${Date.now()}@storm.test` } });
    const theirs = await app(BILLS, other.userId);
    await bill(theirs, "theirs-11", { issuer: "Their Co", amount: 1, dueDate: "2026-11-01" }, "due");
    await choose(theirs);
    await expect(read()).rejects.toThrow("Bill isn't chosen yet");
    await db.client.user.delete({ where: { userId: other.userId } });
  });
});

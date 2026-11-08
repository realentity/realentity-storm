import { KeyRing, seal } from "@realentity/storm-crypto";
import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { emptyUsage, ModelRouter, type LlmClient, type LlmUsage, type StructuredRequest } from "@realentity/storm-llm";
import { type EmailMessage } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type z } from "zod";
import { ImapSmtpConnector } from "../src/mail/imap-smtp-connector";
import { NO_ATTENTION, type StepContext } from "../src/runner/step-executor";
import { CredentialVault } from "../src/secrets/credential-vault";
import { BillReadStep, BillSaveStep } from "../src/steps/bill-steps";
import { APP_PASSWORD, MAILBOX, startMailServer, type TestMailServer } from "./support/greenmail";
import { pdfWithText } from "./support/pdf";

jest.setTimeout(60_000);

/** Reads a bill the way the fixtures write it: "Total <amount> <currency>, due <date>, invoice <ref>". */
class BillReader implements LlmClient {
  prompts: string[] = [];
  structured<S extends z.ZodObject>(request: StructuredRequest<S>): Promise<{ output: z.infer<S>; usage: LlmUsage }> {
    this.prompts.push(request.prompt);
    const found = /Total (\d+\.\d{2}) ([A-Z]{3}), due (\d{4}-\d{2}-\d{2}), invoice ([\w-]+)/.exec(request.prompt);
    const issuer = /From: (?:.*<)?[^@\s<]+@([^>\s]+)/.exec(request.prompt)?.[1] ?? "";
    const answer = found
      ? { isBill: true, issuer, amount: Number(found[1]), currency: found[2], dueDate: found[3], period: found[3].slice(0, 7), reference: found[4] }
      : { isBill: false, issuer: "", amount: 0, currency: "", dueDate: null, period: null, reference: null };
    return Promise.resolve({ output: request.schema.parse(answer), usage: { ...emptyUsage(), calls: 1, costUsd: 0.001 } });
  }
}

/** The Bills App bill.save writes into (M33). */
const BILLS_APP = readFileSync(join(__dirname, "../../../pipelines/apps/bills.yaml"), "utf8");

// M23, M33
describe("bills", () => {
  let server: TestMailServer;
  let db: PrismaConnection;
  let userId: string;
  let connector: ImapSmtpConnector;

  beforeAll(async () => {
    server = await startMailServer();
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    const keys = KeyRing.fromEnv(process.env);
    const credentialId = randomUUID();
    await db.client.credential.create({
      data: { credentialId, userId, name: "mail", kind: "PASSWORD", username: MAILBOX, allowedHosts: [server.host], ...seal(keys, credentialId, APP_PASSWORD) },
    });
    connector = new ImapSmtpConnector(
      { imapHost: server.host, imapPort: server.imapPort, smtpHost: server.host, smtpPort: server.smtpPort, tls: false, credential: "mail" },
      new CredentialVault(db.client, keys),
    );
  }, 120_000);

  let appId: string;

  beforeEach(async () => {
    const app = await db.client.app.create({ data: { userId, name: "Bills" } });
    const version = await db.client.appVersion.create({ data: { appId: app.appId, version: 1, definition: {}, source: BILLS_APP } });
    await db.client.app.update({ where: { appId: app.appId }, data: { currentVersionId: version.appVersionId } });
    appId = app.appId;
  });

  afterEach(async () => {
    await db.client.app.deleteMany();
  });

  afterAll(async () => {
    await db.client.credential.deleteMany();
    await db.close();
    await server.stop();
  });

  const context = (dryRun = false): StepContext => ({
    runId: randomUUID(),
    userId,
    pipelineId: randomUUID(),
    stepId: "s",
    stepKey: "read",
    itemIndex: null,
    dryRun,
    app: "Bills",
    recordUsage: () => undefined,
    attention: NO_ATTENTION,
  });
  const bills = () => db.client.dataEntity.findMany({ where: { appId, type: "Bill" }, orderBy: { key: "asc" } });
  const inbox = async () => (await connector.fetch(userId, { mailbox: "INBOX", after: null, since: new Date(Date.now() - 86_400_000), limit: 50 })).messages;
  const save = (bills: unknown[], dryRun = false) =>
    new BillSaveStep(db.client).execute({ bills, remindDaysBefore: 3, jumpPercent: 30 }, context(dryRun)) as Promise<{
      added: { issuer: string }[];
      updated: { issuer: string }[];
      remind: { remindAt: string; title: string }[];
      jumps: { issuer: string; percent: number }[];
      jumpText: string;
    }>;

  // M23-I1
  it("reads a bill in the text and one in a PDF; a newsletter isn't a bill; saved with their fields, a reminder each", async () => {
    await server.deliver({ from: "billing@evn.test", subject: "Your electricity bill", text: "Dear customer, Total 84.20 BGN, due 2026-11-20, invoice E-1001." });
    await server.deliver({
      from: "invoices@telco.test",
      subject: "Invoice for October",
      text: "Your invoice is attached.",
      attachments: [{ filename: "invoice.pdf", content: pdfWithText("Total 120.50 EUR, due 2026-11-25, invoice T-77").toString("latin1") }],
    });
    await server.deliver({ from: "news@shop.test", subject: "Black Friday deals", text: "Everything 30% off this week." });
    const messages = (await inbox()).filter((m: EmailMessage) => ["billing@evn.test", "invoices@telco.test", "news@shop.test"].includes(m.from));

    const llm = new BillReader();
    const read = (await new BillReadStep(connector, llm, new ModelRouter(() => Promise.resolve(null))).execute({ messages, mailbox: "INBOX" }, context())) as {
      bills: { issuer: string; amount: number; currency: string; dueDate: string; reference: string }[];
      notBills: number;
    };
    expect(read.bills.map((b) => [b.issuer, b.amount, b.currency, b.dueDate, b.reference])).toEqual([
      ["evn.test", 84.2, "BGN", "2026-11-20", "E-1001"],
      ["telco.test", 120.5, "EUR", "2026-11-25", "T-77"],
    ]);
    expect(read.notBills).toBe(1);
    // The PDF's text reached the model inside its own tag; the email's text too.
    expect(llm.prompts[1]).toContain('<attachment index="0">');

    const saved = await save(read.bills);
    expect(saved.added).toHaveLength(2);
    expect(saved.remind.map((r) => [r.title, r.remindAt])).toEqual([
      ["Pay evn.test: 84.20 BGN", "2026-11-17T09:00:00"],
      ["Pay telco.test: 120.50 EUR", "2026-11-22T09:00:00"],
    ]);
    // M33: Bill entities of the App, due until I mark them paid.
    expect((await bills()).map((b) => [b.key, b.stage, b.value])).toEqual([
      [
        "evn.test|E-1001",
        "due",
        expect.objectContaining({ issuer: "evn.test", issuerKey: "evn.test", amount: 84.2, currency: "BGN", dueDate: "2026-11-20", month: "2026-11-01", period: "2026-11" }),
      ],
      ["telco.test|T-77", "due", expect.objectContaining({ issuerKey: "telco.test", amount: 120.5, currency: "EUR", reference: "T-77" })],
    ]);
  });

  // M23-I2
  it("the same bill again keeps one row; a bill well above the issuer's usual is told; a dry run saves nothing", async () => {
    const bill = (month: string, amount: number, reference = `E-${month}`) => ({
      messageId: `<${reference}@evn.test>`,
      from: "billing@evn.test",
      subject: "Your electricity bill",
      issuer: "EVN",
      amount,
      currency: "BGN",
      dueDate: `${month}-20`,
      period: month,
      reference,
    });
    await save([bill("2026-07", 80), bill("2026-08", 90), bill("2026-09", 85)]);

    // Paid by me, then read again (a reminder): it stays paid.
    await db.client.dataEntity.updateMany({ where: { key: "evn.test|E-2026-09" }, data: { stage: "paid" } });
    const again = await save([bill("2026-09", 85)]);
    expect([again.added.length, again.updated.length]).toEqual([0, 1]);
    expect((await bills()).map((b) => b.stage)).toEqual(["due", "due", "paid"]);

    expect((await save([bill("2026-10", 100)], true)).jumps).toEqual([]);
    const dry = await save([bill("2026-11", 130)], true);
    expect(dry.jumps.map((j) => [j.issuer, j.percent])).toEqual([["EVN", 53]]);
    expect(await bills()).toHaveLength(3);

    const jump = await save([bill("2026-11", 130)]);
    expect(jump.jumpText).toBe("Bills higher than usual:\nEVN: 130.00 BGN, 53% above the usual 85.00 (2026-11)");
    expect(await bills()).toHaveLength(4);
  });

  it("needs a pipeline in an App with a Bill type", async () => {
    await expect(new BillSaveStep(db.client).execute({ bills: [], remindDaysBefore: 3, jumpPercent: 30 }, { ...context(), app: undefined })).rejects.toThrow(
      "Bill is an App's type, and this pipeline has no app:",
    );
  });
});

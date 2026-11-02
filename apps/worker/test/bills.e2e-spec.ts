import { KeyRing, seal } from "@ai-me/crypto";
import { createPrismaConnection, type PrismaConnection } from "@ai-me/db";
import { emptyUsage, ModelRouter, type LlmClient, type LlmUsage, type StructuredRequest } from "@ai-me/llm";
import { type EmailMessage } from "@ai-me/steps";
import { TestEnvironment } from "@ai-me/testing";
import { randomUUID } from "node:crypto";
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

// M23
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

  afterEach(async () => {
    await db.client.bill.deleteMany();
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
    recordUsage: () => undefined,
    attention: NO_ATTENTION,
  });
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
    expect(await db.client.bill.findMany({ orderBy: { issuer: "asc" }, select: { issuerKey: true, billKey: true, period: true } })).toEqual([
      { issuerKey: "evn.test", billKey: "evn.test|E-1001", period: "2026-11" },
      { issuerKey: "telco.test", billKey: "telco.test|T-77", period: "2026-11" },
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

    const again = await save([bill("2026-09", 85)]);
    expect([again.added.length, again.updated.length]).toEqual([0, 1]);
    expect(await db.client.bill.count()).toBe(3);

    expect((await save([bill("2026-10", 100)], true)).jumps).toEqual([]);
    const dry = await save([bill("2026-11", 130)], true);
    expect(dry.jumps.map((j) => [j.issuer, j.percent])).toEqual([["EVN", 53]]);
    expect(await db.client.bill.count()).toBe(3);

    const jump = await save([bill("2026-11", 130)]);
    expect(jump.jumpText).toBe("Bills higher than usual:\nEVN: 130.00 BGN, 53% above the usual 85.00 (2026-11)");
    expect(await db.client.bill.count()).toBe(4);
  });
});

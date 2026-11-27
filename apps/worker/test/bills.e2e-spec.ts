import { exampleYaml } from "@realentity/storm-shared/example-files";
import { KeyRing, payloadHash } from "@realentity/storm-crypto";
import { createPrismaConnection, type Prisma, type PrismaConnection } from "@realentity/storm-db";
import { emptyUsage, ModelRouter, type LlmClient, type LlmUsage, type StructuredRequest } from "@realentity/storm-llm";
import { readAppSource } from "@realentity/storm-shared";
import { defaultCatalog, PipelineCompiler } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { type z } from "zod";
import { ImapSmtpConnector } from "../src/mail/imap-smtp-connector";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry, NO_ATTENTION } from "../src/runner/step-executor";
import { EmailAttachmentsStep } from "../src/steps/attachment-steps";
import { FilterStep, SaveStep } from "../src/steps/data-steps";
import { EmailClassifyStep, EmailFetchStep } from "../src/steps/email-steps";
import { ReadStep } from "../src/steps/entity-steps";
import { HistoryStep } from "../src/steps/history-step";
import { ExtractStep } from "../src/steps/llm-steps";
import { MapStep } from "../src/steps/map-alert-steps";
import { addEmailAccount, startMailServer, type TestMailServer } from "./support/greenmail";
import { pdfWithText } from "./support/pdf";
import { Counting, createVersion } from "./support/test-steps";

jest.setTimeout(90_000);

/**
 * Triage: a bill when the email (or its PDF) says "Total"; reading: a bill as the fixtures write it, "Total <amount>
 * <currency>, due <date>, invoice <ref>", the issuer from the sender's domain. Keeps what it was asked.
 */
class BillReader implements LlmClient {
  prompts: string[] = [];
  structured<S extends z.ZodObject>(request: StructuredRequest<S>): Promise<{ output: z.infer<S>; usage: LlmUsage }> {
    this.prompts.push(request.prompt);
    const usage = { ...emptyUsage(), calls: 1, costUsd: 0.001 };
    if (request.system.includes("You triage emails")) {
      const results = [...request.prompt.matchAll(/<email index="(\d+)"[\s\S]*?<\/email>/g)].map(([text, index]) => ({
        index: Number(index),
        label: /Total|attached/.test(text) ? "bill" : "other",
        reason: "test",
      }));
      return Promise.resolve({ output: request.schema.parse({ results }), usage });
    }
    const found = /Total (\d+\.\d{2}) ([A-Z]{3}), due (\d{4}-\d{2}-\d{2}), invoice ([\w-]+)/.exec(request.prompt);
    const issuer = /"from":\s*"[^@"]+@([^"]+)"/.exec(request.prompt)?.[1] ?? "";
    const values = found
      ? { isBill: "yes", issuer, amount: found[1], currency: found[2], dueDate: found[3], period: found[3].slice(0, 7), reference: found[4] }
      : { isBill: "no", issuer: "", amount: "", currency: "", dueDate: "", period: "", reference: "" };
    return Promise.resolve({ output: request.schema.parse({ values: Object.entries(values).map(([name, value]) => ({ name, value })) }), usage });
  }
}

// M23, M33; M71: the Bills App on generic steps only (email.attachments, llm.extract, data.map, data.save, data.history)
describe("examples/apps/bills.yaml", () => {
  const source = exampleYaml("apps/bills.yaml");
  const app = readAppSource(source);
  const compiler = new PipelineCompiler(defaultCatalog());
  let server: TestMailServer;
  let db: PrismaConnection;
  let userId: string;
  let connector: ImapSmtpConnector;
  let appId: string;
  let llm: BillReader;
  let calendar: Counting;
  let telegram: Counting;
  let runner: PipelineRunner;

  beforeAll(async () => {
    server = await startMailServer();
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    await addEmailAccount(db.client, userId, server);
    connector = new ImapSmtpConnector(db.client, KeyRing.fromEnv(process.env));
  }, 120_000);

  beforeEach(async () => {
    const created = await db.client.app.create({ data: { userId, name: "Bills" } });
    const version = await db.client.appVersion.create({ data: { appId: created.appId, version: 1, definition: {}, source } });
    await db.client.app.update({ where: { appId: created.appId }, data: { currentVersionId: version.appVersionId } });
    appId = created.appId;
    llm = new BillReader();
    const router = new ModelRouter(() => Promise.resolve(null));
    calendar = new Counting("calendar.create", (input) => ({ created: true, eventId: `event-${String(input.title)}`, link: "https://calendar.test/e", meetLink: null, invited: [] }));
    telegram = new Counting("notify.telegram", () => ({ sent: true }));
    runner = new PipelineRunner(
      db.client,
      defaultCatalog(),
      new ExecutorRegistry([
        new EmailFetchStep(connector, db.client),
        new EmailClassifyStep(llm, router),
        new EmailAttachmentsStep(connector),
        new ExtractStep(llm, router),
        new MapStep(),
        new SaveStep(db.client),
        new ReadStep(db.client),
        new FilterStep(),
        new HistoryStep(db.client),
        calendar,
        telegram,
      ]),
    );
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.app.deleteMany();
    await db.client.dataPoint.deleteMany();
  });

  afterAll(async () => {
    await db.client.emailAccount.deleteMany();
    await db.close();
    await server.stop();
  });

  const bills = () => db.client.dataEntity.findMany({ where: { appId, type: "Bill" }, orderBy: { key: "asc" } });
  /** A run to its end, every reminder approved at its gate as the inbox does it. */
  const run = async (versionId: string) => {
    const runId = await runner.start(versionId, { trigger: "manual" });
    for (let status = await runner.advance(runId); status !== "DONE"; status = await runner.advance(runId)) {
      if (status !== "WAITING_FOR_USER") {
        const failed = await db.client.step.findMany({ where: { runId, error: { not: null } }, select: { stepKey: true, error: true } });
        throw new Error(`${status}: ${failed.map((f) => `${f.stepKey}: ${f.error}`).join("\n")}`);
      }
      for (const p of await db.client.proposal.findMany({ where: { runId, status: "PENDING_REVIEW" } })) {
        const finalPayload = p.originalPayload as Prisma.InputJsonValue;
        await db.client.proposal.update({ where: { proposalId: p.proposalId }, data: { status: "APPROVED", finalPayload, payloadHash: payloadHash(finalPayload) } });
      }
    }
    return runId;
  };

  it("reads a bill in the text and one in a PDF; a newsletter isn't a bill; each kept as a Bill, a reminder each; read again, a paid one stays paid", async () => {
    await server.deliver({ from: "billing@evn.test", subject: "Your electricity bill", text: "Dear customer, Total 84.20 BGN, due 2026-11-20, invoice E-1001." });
    await server.deliver({
      from: "noreply@telco.test",
      subject: "Invoice for October",
      text: "Your invoice is attached.",
      attachments: [{ filename: "invoice.pdf", content: pdfWithText("Total 120.50 EUR, due 2026-11-25, invoice T-77").toString("latin1") }],
    });
    await server.deliver({ from: "news@shop.test", subject: "Black Friday deals", text: "Everything 30% off this week." });
    const versionId = await createVersion(db.client, userId, exampleYaml("bills"), compiler, { app });

    await run(versionId);
    // A no-reply sender's bill is a bill too; the PDF's text reached the model with the email.
    expect(llm.prompts.some((p) => p.includes("attachmentText") && p.includes("Total 120.50 EUR"))).toBe(true);
    expect(calendar.calls.map((c) => [c.title, c.start])).toEqual([
      ["Pay evn.test: 84.20 BGN", "2026-11-17T09:00:00"],
      ["Pay telco.test: 120.50 EUR", "2026-11-22T09:00:00"],
    ]);
    // M33: Bill entities of the App, due until the user marks them paid.
    expect((await bills()).map((b) => [b.key, b.stage, b.value])).toEqual([
      [
        "evn.test|E-1001",
        "due",
        expect.objectContaining({ issuer: "evn.test", issuerKey: "evn.test", amount: 84.2, currency: "BGN", dueDate: "2026-11-20", month: "2026-11-01", period: "2026-11" }),
      ],
      ["telco.test|T-77", "due", expect.objectContaining({ issuerKey: "telco.test", amount: 120.5, currency: "EUR", reference: "T-77", from: "noreply@telco.test" })],
    ]);

    // Paid by the user; the same bill again (a reminder email) is the same Bill, still paid, and no second reminder.
    await db.client.dataEntity.updateMany({ where: { appId, key: "evn.test|E-1001" }, data: { stage: "paid" } });
    await server.deliver({ from: "billing@evn.test", subject: "Reminder: your electricity bill", text: "Total 84.20 BGN, due 2026-11-20, invoice E-1001." });
    await run(versionId);
    expect((await bills()).map((b) => b.stage)).toEqual(["paid", "due"]);
    expect(calendar.calls).toHaveLength(2);
  });

  it("a bill well above the sender's usual (the median of their last six) is told", async () => {
    const versionId = await createVersion(db.client, userId, exampleYaml("bills"), compiler, { app });
    for (const [month, amount] of [["07", "80.00"], ["08", "90.00"], ["09", "85.00"], ["10", "100.00"]]) {
      await server.deliver({ from: "billing@water.test", subject: `Water 2026-${month}`, text: `Total ${amount} BGN, due 2026-${month}-20, invoice W-${month}` });
      await run(versionId);
    }
    expect(telegram.calls).toEqual([]);
    await server.deliver({ from: "billing@water.test", subject: "Water 2026-11", text: "Total 130.00 BGN, due 2026-11-20, invoice W-11" });
    await run(versionId);
    expect(telegram.calls.map((c) => c.text)).toEqual(["Bills higher than usual:\nwater.test: 130.00 BGN, 49% above the usual 87.50 (2026-11)"]);
  });

  // M71: email.attachments, the generic step the Bills App reads PDFs with
  it("email.attachments: a PDF's and a text file's text, cut at maxChars; an image isn't read; a broken PDF is said, not a failure", async () => {
    await server.deliver({
      from: "office@acme.test",
      subject: "Papers",
      text: "Attached.",
      attachments: [
        { filename: "invoice.pdf", content: pdfWithText("Total 10.00 EUR").toString("latin1") },
        { filename: "notes.txt", content: "x".repeat(300) },
        { filename: "photo.png", content: "not really a png" },
        { filename: "broken.pdf", content: "%PDF-1.4 nothing after it" },
      ],
    });
    const messages = (await connector.fetch({ userId }, { mailbox: "INBOX", after: null, since: new Date(Date.now() - 86_400_000), limit: 50 })).messages.filter(
      (m) => m.subject === "Papers",
    );
    const step = new EmailAttachmentsStep(connector);
    const context = { runId: "r", userId, pipelineId: "p", stepId: "s", stepKey: "files", itemIndex: null, dryRun: false, recordUsage: () => undefined, attention: NO_ATTENTION };
    const result = (await step.execute(defaultCatalog().get("email.attachments")!.input.parse({ messages, maxChars: 100 }), context)) as {
      messages: { files: { filename: string; text: string; truncated: boolean }[]; attachmentText: string }[];
      read: number;
      problems: string[];
    };
    expect(result.messages[0].files.map((f) => [f.filename, f.text.length > 0, f.truncated])).toEqual([
      ["invoice.pdf", true, false],
      ["notes.txt", true, true],
    ]);
    expect(result.messages[0].files[1].text).toHaveLength(100);
    expect(result.messages[0].attachmentText).toMatch(/^--- invoice\.pdf ---\n.*Total 10\.00 EUR[\s\S]*--- notes\.txt ---\nx{100}$/);
    expect(result.read).toBe(2);
    expect(result.problems).toEqual([expect.stringMatching(/^Papers: broken\.pdf: The PDF couldn't be read/)]);
  });

  it("Bills due soon: the unpaid ones due in three days, and the overdue ones, every morning", async () => {
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const bill = (issuer: string, amount: number, dueDate: string, paid = false) =>
      db.client.dataEntity.create({
        data: { appId, type: "Bill", key: `${issuer}|${dueDate}`, value: { billKey: `${issuer}|${dueDate}`, issuer, amount, currency: "BGN", dueDate }, stage: paid ? "paid" : "due" },
      });
    await bill("telco", 30, day(-2));
    await bill("evn", 84.2, day(0));
    await bill("water", 21.5, day(2));
    await bill("rent", 900, day(5));
    await bill("gas", 40, day(1), true);
    const dueSoon = await createVersion(db.client, userId, exampleYaml("due-soon"), compiler, { app });
    await run(dueSoon);
    expect(telegram.calls.map((c) => c.text)).toEqual([
      `Bills:\n• telco: 30.00 BGN, overdue since ${day(-2)}\n• evn: 84.20 BGN, due today\n• water: 21.50 BGN, due ${day(2)}`,
    ]);

    await db.client.dataEntity.updateMany({ where: { appId, type: "Bill" }, data: { stage: "paid" } });
    await run(dueSoon);
    expect(telegram.calls).toHaveLength(1);
  });
});

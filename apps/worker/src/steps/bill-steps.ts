import { type PrismaClient } from "@realentity/storm-db";
import { billValue, type EmailMessage } from "@realentity/storm-steps";
import { z } from "zod";
import { type MailConnector } from "../mail/mail-connector";
import { type StepContext, type StepExecutor } from "../runner/step-executor";
import { appType } from "./entity-steps";
import { emailBlock } from "./email-block";
import { pdfText } from "./file-steps";
import { DATA_ONLY, LlmStep } from "./llm-steps";

/** A bill's PDF is small; a message bigger than this is read without its attachments. */
const MAX_MESSAGE_BYTES = 10 * 1_048_576;
/** Per email: two PDFs, and enough of each for the totals. */
const MAX_PDFS = 2;
const PDF_CHARS = 8_000;
/** The usual amount: the median of this many of the issuer's earlier bills. */
const USUAL_OF = 6;

const BillAnswerSchema = z.object({
  isBill: z.boolean().describe("an amount I have to pay: an invoice, a utility bill, a payment request; not a receipt of a payment already made, an offer or a newsletter"),
  issuer: z.string().max(200).describe("who bills, short: the company name as the bill gives it"),
  amount: z.number().nonnegative().describe("the total to pay, as a number"),
  currency: z.string().max(8).describe("ISO 4217 code, e.g. BGN, EUR"),
  dueDate: z.string().nullable().describe("the date to pay by, YYYY-MM-DD; null if the bill gives none"),
  period: z.string().nullable().describe("the month the bill is for, YYYY-MM; null if none"),
  reference: z.string().max(100).nullable().describe("the invoice or bill number; null if none"),
});

const SYSTEM = [
  "You read bills for me out of an email and the text of its PDF attachments. Rules:",
  "- isBill: true only when it asks me to pay an amount (an invoice, a utility or phone bill, a payment request). " +
    "A receipt for a payment already made, an order confirmation, an offer or a newsletter is not a bill.",
  "- Read numbers exactly as written; the amount is the total to pay (with VAT), not a subtotal. A decimal comma is a decimal point.",
  "- Never guess: a date, period or reference the text doesn't give is null. When it isn't a bill, the other fields can be empty.",
  DATA_ONLY,
].join("\n");

/** bill.read (M23): bills out of emails and their PDFs. The LLM reads; the amounts are checked against the text. */
export class BillReadStep extends LlmStep {
  readonly type = "bill.read";

  constructor(
    private readonly mail: MailConnector,
    ...rest: ConstructorParameters<typeof LlmStep>
  ) {
    super(...rest);
  }

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { messages, mailbox } = input as { messages: EmailMessage[]; mailbox: string };
    const bills = [];
    let notBills = 0;
    for (const message of messages) {
      const pdfs = await this.pdfsOf(context.userId, mailbox, message);
      const prompt = [emailBlock(message), ...pdfs.map((text, i) => `<attachment index="${i}">\n${text}\n</attachment>`)].join("\n\n");
      const answer = await this.call(context, SYSTEM, prompt, BillAnswerSchema, true);
      if (!answer.isBill || answer.amount <= 0) {
        notBills++;
        continue;
      }
      bills.push({
        messageId: message.messageId,
        from: message.from,
        subject: message.subject,
        issuer: answer.issuer.trim() || message.fromName || message.from,
        amount: Math.round(answer.amount * 100) / 100,
        currency: answer.currency.trim().toUpperCase() || "BGN",
        dueDate: isoDate(answer.dueDate),
        period: /^\d{4}-\d{2}$/.test(answer.period ?? "") ? answer.period : null,
        reference: answer.reference?.trim() || null,
      });
    }
    return { bills, notBills };
  }

  /** The text of the email's PDF attachments; a PDF that can't be read is left out, not a failure. */
  private async pdfsOf(userId: string, mailbox: string, message: EmailMessage): Promise<string[]> {
    const listed = message.attachments.filter((a) => a.contentType === "application/pdf" || /\.pdf$/i.test(a.filename ?? ""));
    if (listed.length === 0) return [];
    const attachments = await this.mail.attachments(userId, { mailbox, uid: message.uid, maxBytes: MAX_MESSAGE_BYTES });
    const texts: string[] = [];
    for (const attachment of attachments.filter((a) => a.contentType === "application/pdf" || /\.pdf$/i.test(a.filename ?? "")).slice(0, MAX_PDFS)) {
      const text = await pdfText(attachment.content).catch(() => "");
      if (text.trim()) texts.push(text.trim().slice(0, PDF_CHARS));
    }
    return texts;
  }
}

interface ReadBill {
  messageId: string;
  from: string;
  subject: string;
  issuer: string;
  amount: number;
  currency: string;
  dueDate: string | null;
  period: string | null;
  reference: string | null;
}

/**
 * bill.save (M23): bills kept as Bill entities of the pipeline's App (M33, pipelines/apps/bills.yaml), by the sender's
 * domain with the bill's reference, period or due date: the same bill read again (a reminder, the run retried)
 * updates it, keeping whether I paid it. A new one is `due`, and compared with the issuer's usual amount; a dry run
 * saves nothing.
 */
export class BillSaveStep implements StepExecutor {
  readonly type = "bill.save";

  constructor(private readonly prisma: PrismaClient) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { bills, remindDaysBefore, jumpPercent } = input as { bills: ReadBill[]; remindDaysBefore: number; jumpPercent: number };
    const { appId, app } = await appType(this.prisma, context, "Bill");
    const added: ReadBill[] = [];
    const updated: ReadBill[] = [];
    const jumps: (ReadBill & { usual: number; percent: number })[] = [];
    for (const bill of bills) {
      const issuerKey = domainOf(bill.from);
      const billKey = `${issuerKey}|${bill.reference ?? bill.period ?? bill.dueDate ?? bill.messageId}`;
      const where = { appId_type_key: { appId, type: "Bill", key: billKey } };
      const existing = await this.prisma.dataEntity.findUnique({ where });
      if (existing && !existing.removedAt) {
        updated.push(bill);
      } else {
        added.push(bill);
        const usual = await this.usual(appId, issuerKey, bill.currency);
        if (usual !== null && bill.amount > usual * (1 + jumpPercent / 100)) {
          jumps.push({ ...bill, usual, percent: Math.round((bill.amount / usual - 1) * 100) });
        }
      }
      if (context.dryRun) continue;
      const value = billValue(bill, billKey, issuerKey);
      const now = new Date();
      await this.prisma.dataEntity.upsert({
        where,
        create: { appId, type: "Bill", key: billKey, value, stage: "due", stageDates: { due: now.toISOString() }, firstSeenAt: now, lastSeenAt: now },
        update: { value, lastSeenAt: now, removedAt: null },
      });
      if (!existing) {
        await context.emit?.("entity.changed", {
          app: app.name,
          appId,
          type: "Bill",
          key: billKey,
          item: { ...value, status: "due" },
          before: null,
          changed: [...Object.keys(value), "status"],
          by: "pipeline",
          stage: { from: null, to: "due" },
        });
      }
    }
    const remind = added
      .filter((bill) => bill.dueDate)
      .map((bill) => ({ ...bill, remindAt: `${shiftDays(bill.dueDate!, -remindDaysBefore)}T09:00:00`, title: `Pay ${bill.issuer}: ${bill.amount.toFixed(2)} ${bill.currency}` }));
    const jumpText = jumps
      .map((j) => `${j.issuer}: ${j.amount.toFixed(2)} ${j.currency}, ${j.percent}% above the usual ${j.usual.toFixed(2)}${j.period ? ` (${j.period})` : ""}`)
      .join("\n");
    return { added, updated, remind, jumps, jumpText: jumpText ? `Bills higher than usual:\n${jumpText}` : "" };
  }

  /** The median of the issuer's last six bills in this currency, or null with fewer than two. */
  private async usual(appId: string, issuerKey: string, currency: string): Promise<number | null> {
    const earlier = await this.prisma.dataEntity.findMany({
      where: { appId, type: "Bill", AND: [{ value: { path: ["issuerKey"], equals: issuerKey } }, { value: { path: ["currency"], equals: currency } }] },
      orderBy: { firstSeenAt: "desc" },
      take: 50,
      select: { value: true, firstSeenAt: true },
    });
    const bills = earlier.map((e) => e.value as { amount?: unknown; period?: unknown });
    // The latest periods first (a bill read late is still its month's); then the newest.
    const amounts = bills
      .map((b, i) => ({ amount: Number(b.amount), period: typeof b.period === "string" ? b.period : "", i }))
      .filter((b) => Number.isFinite(b.amount))
      .sort((a, b) => b.period.localeCompare(a.period) || a.i - b.i)
      .slice(0, USUAL_OF)
      .map((b) => b.amount)
      .sort((a, b) => a - b);
    if (amounts.length < 2) return null;
    const middle = Math.floor(amounts.length / 2);
    return amounts.length % 2 ? amounts[middle] : (amounts[middle - 1] + amounts[middle]) / 2;
  }
}

function domainOf(address: string): string {
  return (address.split("@")[1] ?? address).toLowerCase();
}

function isoDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) ? null : value;
}

function shiftDays(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

import { Prisma, type PrismaClient } from "@ai-me/db";
import { type EmailMessage } from "@ai-me/steps";
import { z } from "zod";
import { type MailConnector } from "../mail/mail-connector";
import { type StepContext, type StepExecutor } from "../runner/step-executor";
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
 * bill.save (M23): bills kept for the Bills page. The same bill read again (a reminder, the run retried) updates its
 * row instead of adding one. New ones are compared with the issuer's usual amount; a dry run saves nothing.
 */
export class BillSaveStep implements StepExecutor {
  readonly type = "bill.save";

  constructor(private readonly prisma: PrismaClient) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { bills, remindDaysBefore, jumpPercent } = input as { bills: ReadBill[]; remindDaysBefore: number; jumpPercent: number };
    const added: ReadBill[] = [];
    const updated: ReadBill[] = [];
    const jumps: (ReadBill & { usual: number; percent: number })[] = [];
    for (const bill of bills) {
      const issuerKey = domainOf(bill.from);
      const billKey = `${issuerKey}|${bill.reference ?? bill.period ?? bill.dueDate ?? bill.messageId}`;
      const existing = await this.prisma.bill.findUnique({ where: { userId_billKey: { userId: context.userId, billKey } } });
      if (existing) {
        updated.push(bill);
      } else {
        added.push(bill);
        const usual = await this.usual(context.userId, issuerKey, bill.currency);
        if (usual !== null && bill.amount > usual * (1 + jumpPercent / 100)) {
          jumps.push({ ...bill, usual, percent: Math.round((bill.amount / usual - 1) * 100) });
        }
      }
      if (context.dryRun) continue;
      const data = {
        issuer: bill.issuer,
        issuerKey,
        amount: new Prisma.Decimal(bill.amount),
        currency: bill.currency,
        dueDate: bill.dueDate ? new Date(`${bill.dueDate}T00:00:00Z`) : null,
        period: bill.period,
        reference: bill.reference,
        messageId: bill.messageId,
        from: bill.from,
        subject: bill.subject,
        runId: context.runId,
      };
      await this.prisma.bill.upsert({
        where: { userId_billKey: { userId: context.userId, billKey } },
        create: { userId: context.userId, billKey, ...data },
        update: data,
      });
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
  private async usual(userId: string, issuerKey: string, currency: string): Promise<number | null> {
    const earlier = await this.prisma.bill.findMany({
      where: { userId, issuerKey, currency },
      orderBy: [{ period: "desc" }, { dateCreated: "desc" }],
      take: USUAL_OF,
      select: { amount: true },
    });
    if (earlier.length < 2) return null;
    const amounts = earlier.map((b) => Number(b.amount)).sort((a, b) => a - b);
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

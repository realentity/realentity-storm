import { type Bill } from "@ai-me/db";
import { type BillsView, type BillView } from "@ai-me/shared";
import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

const MONTHS = 12;

/** The bills bill.save kept (M23): read-only but for marking one paid. */
@Injectable()
export class BillsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, now = new Date()): Promise<BillsView> {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - MONTHS + 1, 1));
    const first = from.toISOString().slice(0, 7);
    const rows = await this.prisma.client.bill.findMany({ where: { userId } });
    const bills = rows.map(view).filter((bill) => bill.month >= first);
    // The newest month first; in a month, the first due first, then by issuer.
    bills.sort((a, b) => b.month.localeCompare(a.month) || (a.dueDate ?? "~").localeCompare(b.dueDate ?? "~") || a.issuer.localeCompare(b.issuer));
    const totals = new Map<string, { month: string; currency: string; amount: number; unpaid: number }>();
    for (const bill of bills) {
      const key = `${bill.month} ${bill.currency}`;
      const total = totals.get(key) ?? { month: bill.month, currency: bill.currency, amount: 0, unpaid: 0 };
      total.amount = round(total.amount + bill.amount);
      if (!bill.paidAt) total.unpaid = round(total.unpaid + bill.amount);
      totals.set(key, total);
    }
    return { bills, totals: [...totals.values()] };
  }

  async setPaid(userId: string, billId: string, paid: boolean): Promise<BillView> {
    const bill = await this.prisma.client.bill.findFirst({ where: { billId, userId } });
    if (!bill) throw new NotFoundException();
    return view(await this.prisma.client.bill.update({ where: { billId }, data: { paidAt: paid ? (bill.paidAt ?? new Date()) : null } }));
  }
}

function view(bill: Bill): BillView {
  const dueDate = bill.dueDate?.toISOString().slice(0, 10) ?? null;
  return {
    billId: bill.billId,
    issuer: bill.issuer,
    amount: Number(bill.amount),
    currency: bill.currency,
    dueDate,
    month: bill.period ?? dueDate?.slice(0, 7) ?? bill.dateCreated.toISOString().slice(0, 7),
    reference: bill.reference,
    from: bill.from,
    subject: bill.subject,
    paidAt: bill.paidAt?.toISOString() ?? null,
    dateCreated: bill.dateCreated.toISOString(),
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

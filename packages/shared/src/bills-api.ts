import { z } from "zod";

/** A bill on the Bills page (M23). */
export interface BillView {
  billId: string;
  issuer: string;
  amount: number;
  currency: string;
  /** YYYY-MM-DD */
  dueDate: string | null;
  /** The month it is for (YYYY-MM): the bill's own period, else its due date's month, else when it came. */
  month: string;
  reference: string | null;
  from: string;
  subject: string;
  paidAt: string | null;
  dateCreated: string;
}

export interface BillsView {
  /** The last twelve months, the newest first. */
  bills: BillView[];
  /** Per month and currency, the newest first. */
  totals: { month: string; currency: string; amount: number; unpaid: number }[];
}

export const BillPaidSchema = z.object({ paid: z.boolean() }).strict();
export type BillPaidRequest = z.infer<typeof BillPaidSchema>;

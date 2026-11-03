import { type DataType } from "@ai-me/shared";
import { type EntityContract } from "./catalog";

/**
 * What a type lacks for a step that writes entities of its own (M33): its key, a field of the kind written, a state it
 * sets. Empty: the type fits.
 */
export function contractProblems(type: DataType, contract: EntityContract): string[] {
  const problems: string[] = [];
  if (type.key !== contract.key) problems.push(`its key must be ${contract.key}`);
  if (contract.mine && !type.mine) problems.push("it must be a type of mine (mine: true)");
  if (!contract.mine && type.mine) problems.push("it can't be a type of mine");
  for (const [name, kind] of Object.entries(contract.fields)) {
    const field = type.fields[name];
    if (!field) problems.push(`${name} (${kind}) is missing`);
    else if (field.type !== kind) problems.push(`${name} must be ${kind}, not ${field.type}`);
    else if (field.mine && !contract.mine) problems.push(`${name} can't be mine`);
  }
  for (const state of contract.states ?? []) {
    if (!type.stages?.states.includes(state)) problems.push(`its stages need the state "${state}"`);
  }
  return problems;
}

/** A shop line of a Product (M33): "https://shop/p/7", optionally "| size: M, color: Black" for its variant. */
export function parseShopLine(line: string): { url: string; select?: Record<string, string>; variant?: string } | null {
  const [address = "", variantText] = line.split("|", 2).map((part) => part.trim());
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!variantText) return { url: url.href };
  const select: Record<string, string> = {};
  for (const pair of variantText.split(",")) {
    const [name = "", value = ""] = pair.split(":", 2).map((part) => part.trim());
    if (!name || !value) return null;
    select[name] = value;
  }
  const variant = Object.entries(select)
    .map(([name, value]) => `${name}: ${value}`)
    .join(", ");
  return { url: url.href, select, variant };
}

/** An Offer's key: the product, the shop's address, and its variant. */
export function offerKey(product: string, url: string, variant?: string): string {
  return [product, url, ...(variant ? [variant] : [])].join(" | ");
}

export interface BillFields {
  issuer: string;
  amount: number;
  currency: string;
  dueDate: string | null;
  period: string | null;
  reference: string | null;
  from: string;
  subject: string;
  messageId: string;
}

/**
 * A bill as its Bill entity keeps it (bill.save and the move from the old Bills page): the month it is for is its
 * period, else its due date's, else `fallbackMonth` (when it came).
 */
export function billValue(
  bill: BillFields,
  billKey: string,
  issuerKey: string,
  fallbackMonth = new Date().toISOString().slice(0, 7),
): Record<string, string | number> {
  const month = bill.period ?? bill.dueDate?.slice(0, 7) ?? fallbackMonth;
  const value: Record<string, string | number> = {
    billKey,
    issuer: bill.issuer,
    issuerKey,
    amount: bill.amount,
    currency: bill.currency,
    month: `${month}-01`,
    from: bill.from,
    subject: bill.subject,
    messageId: bill.messageId,
  };
  if (bill.dueDate) value.dueDate = bill.dueDate;
  if (bill.period) value.period = bill.period;
  if (bill.reference) value.reference = bill.reference;
  return value;
}

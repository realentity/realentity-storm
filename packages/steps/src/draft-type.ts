import { DataTypeSchema, ENTITY_FIELD, type DataType, type EntityField, type FieldKind } from "@ai-me/shared";

type Item = Record<string, unknown>;

/** Fields a draft type takes at most; the rest stay with each entity as raw data. */
const MAX_FIELDS = 40;
const KEY_NAMES = ["url", "id", "key", "link", "uuid", "guid", "slug", "code"];
const TITLE_NAMES = ["title", "name", "position", "subject", "label", "headline"];

/**
 * A data type drafted from sample items (M30-T7), without an LLM: each field's kind from its values (an ISO date, an
 * http(s) address, a number, `{ amount, currency }` as money), nested objects as dotted fields, mixed values as text.
 * A field in every item is required; the key is a field whose value differs in every item. A draft to edit, not a
 * decision: names and which fields matter are mine to choose.
 */
export function draftType(items: Item[]): DataType | null {
  const samples = items.filter((item) => item && typeof item === "object" && !Array.isArray(item)).slice(0, 500);
  if (samples.length === 0) return null;

  const seen = new Map<string, unknown[]>();
  const money = new Map<string, string>();
  for (const item of samples) collect(item, "", 0, seen, money);

  const fields: Record<string, EntityField> = {};
  for (const [name, values] of seen) {
    if (Object.keys(fields).length >= MAX_FIELDS) break;
    if ([...seen.keys()].some((other) => other.startsWith(`${name}.`))) continue; // sometimes a value, sometimes an object
    const present = values.filter((v) => v !== null && v !== undefined && v !== "");
    if (present.length === 0) continue;
    const kind = kindOf(present);
    const field: EntityField = { type: kind, required: present.length === samples.length, mine: false };
    if (kind === "text") {
      const distinct = [...new Set(present as string[])];
      if (samples.length >= 8 && distinct.length <= 5 && distinct.length < present.length / 2 && distinct.every((v) => v.length <= 30)) {
        field.type = "enum";
        field.values = distinct.sort();
      }
    }
    if (kind === "number" && money.has(name)) {
      field.type = "money";
      field.currency = money.get(name);
    }
    fields[name] = field;
  }
  for (const currency of money.values()) {
    if (fields[currency]?.type === "enum") {
      fields[currency] = { type: "text", required: fields[currency].required, mine: false };
    }
  }
  if (Object.keys(fields).length === 0) return null;

  const unique = (name: string) => {
    const values = (seen.get(name) ?? []).map((v) => (typeof v === "number" ? String(v) : v));
    return fields[name]?.required && new Set(values).size === samples.length;
  };
  const keyKinds: FieldKind[] = ["text", "url", "email", "number"];
  const candidates = Object.keys(fields).filter((name) => keyKinds.includes(fields[name].type) && unique(name));
  const key =
    candidates.find((name) => KEY_NAMES.includes(leaf(name).toLowerCase())) ??
    candidates.find((name) => fields[name].type === "url") ??
    candidates[0];
  if (!key) return null;
  const titled = Object.keys(fields).filter((name) => name !== key && fields[name].type === "text");
  const title = titled.find((name) => TITLE_NAMES.includes(leaf(name).toLowerCase())) ?? titled[0];

  const parsed = DataTypeSchema.safeParse({ key, ...(title ? { title } : {}), fields });
  return parsed.success ? parsed.data : null;
}

function leaf(name: string): string {
  return name.split(".").at(-1) ?? name;
}

/** Leaf values by dotted path; `{ amount, currency }` noted as money (amount's path → currency's path). */
function collect(value: Item, prefix: string, depth: number, seen: Map<string, unknown[]>, money: Map<string, string>): void {
  const entries = Object.entries(value);
  const amount = entries.find(([k, v]) => /^(amount|value|price)$/i.test(k) && valueKind(v) === "number");
  const currency = entries.find(([k, v]) => /^(currency|currencyCode|priceCurrency)$/i.test(k) && typeof v === "string");
  if (amount && currency) money.set(`${prefix}${amount[0]}`, `${prefix}${currency[0]}`);
  for (const [key, inner] of entries) {
    const name = `${prefix}${key}`;
    if (!ENTITY_FIELD.test(name)) continue;
    if (inner && typeof inner === "object" && !Array.isArray(inner) && depth < 3) {
      collect(inner as Item, `${name}.`, depth + 1, seen, money);
      continue;
    }
    const values = seen.get(name) ?? [];
    values.push(inner);
    seen.set(name, values);
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** "399", "4 500", "12.5": a number as text. Not "007" (an id), and not a date. */
const NUMBER_TEXT = /^-?(0|[1-9]\d{0,2}([ ,]?\d{3})*)([.,]\d+)?$/;

/** One kind for all the values; text when they don't agree. */
function kindOf(values: unknown[]): FieldKind {
  const kinds = new Set(values.map(valueKind));
  if (kinds.size === 1) return [...kinds][0];
  if ([...kinds].every((k) => k === "date" || k === "datetime")) return "datetime";
  if ([...kinds].every((k) => k === "text" || k === "longtext")) return "longtext";
  return "text";
}

function valueKind(value: unknown): FieldKind {
  if (typeof value === "boolean") return "yesno";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "list";
  if (typeof value !== "string") return "text";
  const text = value.trim();
  if (NUMBER_TEXT.test(text)) return "number";
  if (ISO_DATE.test(text)) return "date";
  if (ISO_DATETIME.test(text) && !Number.isNaN(Date.parse(text))) return "datetime";
  if (/^https?:\/\/\S+$/i.test(text)) return "url";
  if (EMAIL.test(text)) return "email";
  if (text.length > 200 || text.includes("\n")) return "longtext";
  return "text";
}

/**
 * M34-T4: a field drafted from the values entities have for it: its kind as a draft type reads them, an enum from a
 * few repeated values, never required (the entities kept so far may lack it).
 */
export function draftField(values: unknown[]): EntityField | null {
  const present = values.filter((v) => v !== null && v !== undefined && v !== "");
  if (present.length === 0) return null;
  const kind = kindOf(present);
  const distinct = kind === "text" ? [...new Set(present as string[])] : [];
  if (present.length >= 8 && distinct.length > 0 && distinct.length <= 5 && distinct.length < present.length / 2 && distinct.every((v) => v.length <= 30)) {
    return { type: "enum", values: distinct.sort(), required: false, mine: false };
  }
  return { type: kind, required: false, mine: false };
}

/** Leaf values by dotted path of a value, as a draft type reads them. */
export function leafValues(value: Record<string, unknown>): Map<string, unknown[]> {
  const seen = new Map<string, unknown[]>();
  collect(value, "", 0, seen, new Map());
  return seen;
}

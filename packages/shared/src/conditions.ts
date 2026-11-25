import { entityValueAt } from "./app";
import { canonicalJson } from "./canonical-json";

type Item = Record<string, unknown>;

/**
 * data.filter's and data.read's `where` (M65: also a page's sources and filters, in the api). Moved here from the
 * worker so both match the same way.
 */

/** A field of an item by dotted path ("company.name"); undefined when missing. */
export const valueAt: (item: Item, path: string) => unknown = entityValueAt;

export const CONDITION_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "in", "nin"] as const;

export interface Condition {
  field: string;
  op: (typeof CONDITION_OPS)[number];
  value: unknown;
}

export interface MatchOptions {
  /** M65: fields whose list entries match without case (a `list of text` that isn't `caseSensitive`). */
  caseless?: ReadonlySet<string>;
}

/** Every condition holds for the item (data.filter, data.read's `where`). */
export function matchesAll(item: Item, where: readonly Condition[], options: MatchOptions = {}): boolean {
  return where.every((condition) => matches(valueAt(item, condition.field), condition, options.caseless?.has(condition.field) ?? false));
}

export function matches(actual: unknown, { op, value }: Pick<Condition, "op" | "value">, caseless = false): boolean {
  switch (op) {
    case "eq":
      return same(actual, value);
    case "neq":
      return !same(actual, value);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const order = compare(actual, value);
      if (order === null) return false;
      return op === "gt" ? order > 0 : op === "gte" ? order >= 0 : op === "lt" ? order < 0 : order <= 0;
    }
    case "contains":
      if (typeof actual === "string" && typeof value === "string") return actual.toLowerCase().includes(value.toLowerCase());
      if (!Array.isArray(actual)) return false;
      // M65: a tag matches "Home" and "home" alike, unless the list is case-sensitive.
      if (caseless && typeof value === "string") return actual.some((entry) => typeof entry === "string" && entry.toLowerCase() === value.toLowerCase());
      return actual.some((entry) => same(entry, value));
    case "in":
      return Array.isArray(value) && value.some((entry) => same(actual, entry));
    case "nin":
      // M58-T9: not one of the list's values; a value that isn't a list (an empty step's) leaves out nothing.
      return !(Array.isArray(value) && value.some((entry) => same(actual, entry)));
  }
}

function same(a: unknown, b: unknown): boolean {
  return a !== undefined && canonicalJson(a) === canonicalJson(b);
}

/** Numbers compare as numbers, strings as strings (ISO dates order correctly); anything else doesn't compare. */
function compare(a: unknown, b: unknown): number | null {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

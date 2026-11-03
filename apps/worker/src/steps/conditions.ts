import { canonicalJson } from "@ai-me/shared";

type Item = Record<string, unknown>;

/** A field of an item by dotted path ("company.name"); undefined when missing. */
export function valueAt(item: Item, path: string): unknown {
  let current: unknown = item;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Item)[segment];
  }
  return current;
}

export interface Condition {
  field: string;
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "in";
  value: unknown;
}

/** Every condition holds for the item (data.filter, data.read's `where`). */
export function matchesAll(item: Item, where: readonly Condition[]): boolean {
  return where.every((condition) => matches(valueAt(item, condition.field), condition));
}

export function matches(actual: unknown, { op, value }: Condition): boolean {
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
      return Array.isArray(actual) && actual.some((entry) => same(entry, value));
    case "in":
      return Array.isArray(value) && value.some((entry) => same(actual, entry));
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

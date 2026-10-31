import { canonicalJson } from "@ai-me/shared";
import { type StepExecutor } from "../runner/step-executor";

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

/** data.dedupe: the first item per `key` value wins. Items without the key are all kept. */
export class DedupeStep implements StepExecutor {
  readonly type = "data.dedupe";

  execute(input: Record<string, unknown>): Promise<unknown> {
    const { from, key } = input as { from: Item[]; key: string };
    const seen = new Set<string>();
    const items = from.filter((item) => {
      const value = valueAt(item, key);
      if (value === undefined || value === null) return true;
      const id = canonicalJson(value);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    return Promise.resolve({ items, duplicates: from.length - items.length });
  }
}

interface Condition {
  field: string;
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "in";
  value: unknown;
}

/** data.filter: keeps items matching every condition. */
export class FilterStep implements StepExecutor {
  readonly type = "data.filter";

  execute(input: Record<string, unknown>): Promise<unknown> {
    const { items, where } = input as { items: Item[]; where: Condition[] };
    const kept = items.filter((item) => where.every((condition) => matches(valueAt(item, condition.field), condition)));
    return Promise.resolve({ items: kept, removed: items.length - kept.length });
  }
}

function matches(actual: unknown, { op, value }: Condition): boolean {
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

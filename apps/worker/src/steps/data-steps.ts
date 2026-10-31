import { type JobPosting, type JobPostingStatus, type PrismaClient } from "@ai-me/db";
import { canonicalJson } from "@ai-me/shared";
import { type StepContext, type StepExecutor } from "../runner/step-executor";

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

/**
 * data.dedupe: the first item per `key` value wins. Items without the key are all kept. With `against: JobPosting`,
 * items whose key is the URL of a posting saved before (data.save) go too: each posting comes through once.
 */
export class DedupeStep implements StepExecutor {
  readonly type = "data.dedupe";

  constructor(private readonly prisma?: PrismaClient) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { from, key, against } = input as { from: Item[]; key: string; against?: "JobPosting" };
    const seen = new Set<string>();
    let items = from.filter((item) => {
      const value = valueAt(item, key);
      if (value === undefined || value === null) return true;
      const id = canonicalJson(value);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (against) {
      if (!this.prisma) throw new Error("data.dedupe against saved items needs the database");
      const urls = items.map((item) => valueAt(item, key)).filter((value): value is string => typeof value === "string");
      const saved = new Set(
        (await this.prisma.jobPosting.findMany({ where: { userId: context.userId, url: { in: urls } }, select: { url: true } })).map((p) => p.url),
      );
      items = items.filter((item) => !saved.has(valueAt(item, key) as string));
    }
    return { items, duplicates: from.length - items.length };
  }
}

const STATUS_RANK: Record<JobPostingStatus, number> = { NEW: 0, SKIPPED: 1, SHORTLISTED: 1, APPLIED: 2 };

/**
 * data.save into JobPosting (the Jobs page): one posting per URL. Saving one again refreshes what it says and when
 * it was last seen; the status moves forward only (a posting I applied to stays applied, NEW never undoes a
 * decision). A dry run saves nothing and says what it would have.
 */
export class SaveStep implements StepExecutor {
  readonly type = "data.save";

  constructor(private readonly prisma: PrismaClient) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { items, status } = input as { items: Item[]; status: "NEW" | "SKIPPED" | "SHORTLISTED" };
    const postings = items.map(posting).filter((p) => p !== null);
    const existing = new Map(
      (
        await this.prisma.jobPosting.findMany({
          where: { userId: context.userId, url: { in: postings.map((p) => p.url) } },
          select: { jobPostingId: true, url: true, status: true },
        })
      ).map((p) => [p.url, p]),
    );
    const created = postings.filter((p) => !existing.has(p.url)).length;
    if (!context.dryRun) {
      const now = new Date();
      for (const p of postings) {
        const before = existing.get(p.url);
        if (!before) {
          await this.prisma.jobPosting.create({ data: { userId: context.userId, ...p, status, lastSeenAt: now } });
          existing.set(p.url, { jobPostingId: "", url: p.url, status });
          continue;
        }
        const forward = STATUS_RANK[status] > STATUS_RANK[before.status];
        await this.prisma.jobPosting.updateMany({
          where: { userId: context.userId, url: p.url },
          data: { ...withoutEmpty(p), lastSeenAt: now, ...(forward ? { status } : {}) },
        });
      }
    }
    return { saved: postings.length, created, skipped: items.length - postings.length };
  }
}

type Posting = Pick<JobPosting, "url" | "title" | "source"> &
  Partial<Pick<JobPosting, "company" | "location" | "description" | "score" | "scoreReason" | "externalId">>;

/** An item as a posting: it needs a URL and a title; other fields as far as they are there. */
function posting(item: Item): Posting | null {
  const text = (name: string, max = 500) => {
    const value = item[name];
    return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : typeof value === "number" ? String(value) : undefined;
  };
  const url = text("url", 2000);
  const title = text("title");
  if (!url || !/^https?:\/\//.test(url) || !title) return null;
  const score = typeof item.score === "number" ? item.score : undefined;
  return {
    url,
    title,
    source: text("source", 100) ?? new URL(url).hostname,
    company: text("company"),
    location: text("location"),
    description: text("description", 20_000),
    score,
    scoreReason: text("scoreReason", 2000),
    externalId: text("externalId", 200),
  };
}

function withoutEmpty<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
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

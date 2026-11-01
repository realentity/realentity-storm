import { type JobPosting, type JobPostingStatus, type Prisma, type PrismaClient } from "@ai-me/db";
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

interface SaveInput {
  items: Item[];
  status: "NEW" | "SKIPPED" | "SHORTLISTED";
  collection?: string;
  key?: string;
  fields?: string[];
  complete: boolean;
}

interface Change {
  key: string;
  item: Item;
  before: Item;
  after: Item;
}

/**
 * data.save into JobPosting (the Jobs page): one posting per URL. Saving one again refreshes what it says and when
 * it was last seen; the status moves forward only (a posting I applied to stays applied, NEW never undoes a
 * decision). With `collection` (M13), into a list of mine by `key`, saying what was added, what changed and, for a
 * complete list, what was removed since the last save. A dry run saves nothing and says what it would have.
 */
export class SaveStep implements StepExecutor {
  readonly type = "data.save";

  constructor(private readonly prisma: PrismaClient) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const save = input as unknown as SaveInput;
    if (save.collection) return this.intoCollection(save, save.collection, context);
    const { items, status } = save;
    const postings = items.map(posting).filter((p) => p !== null);
    const existing = new Map(
      (
        await this.prisma.jobPosting.findMany({
          where: { userId: context.userId, url: { in: postings.map((p) => p.url) } },
          select: { jobPostingId: true, url: true, status: true },
        })
      ).map((p) => [p.url, p]),
    );
    const createdUrls = new Set(postings.filter((p) => !existing.has(p.url)).map((p) => p.url));
    const created = createdUrls.size;
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
    const added = items.filter((item) => {
      const p = posting(item);
      return p !== null && createdUrls.has(p.url);
    });
    return { saved: postings.length, created, skipped: items.length - postings.length, added, changed: [], removed: [] };
  }

  private async intoCollection({ items, key, fields, complete }: SaveInput, collection: string, context: StepContext): Promise<unknown> {
    if (!key) throw new Error("data.save into a collection needs `key`: the field that identifies an item");
    // One item per key; a key that repeats keeps its last item.
    const keyed = new Map<string, Item>();
    for (const item of items) {
      const k = keyOf(item, key);
      if (k) keyed.set(k, item);
    }
    const userId = context.userId;
    const saved = await this.prisma.dataRecord.findMany({
      where: complete ? { userId, collection } : { userId, collection, key: { in: [...keyed.keys()] } },
    });
    const before = new Map(saved.map((r) => [r.key, r]));

    const added: Item[] = [];
    const changed: Change[] = [];
    for (const [k, item] of keyed) {
      const old = before.get(k);
      if (!old || old.removedAt) {
        added.push(item);
        continue;
      }
      const previous = old.value as Item;
      const compared = fields ?? [...new Set([...Object.keys(previous), ...Object.keys(item)])];
      const differs = compared.filter((f) => canonicalJson(valueAt(previous, f) ?? null) !== canonicalJson(valueAt(item, f) ?? null));
      if (differs.length > 0) {
        changed.push({
          key: k,
          item,
          before: Object.fromEntries(differs.map((f) => [f, valueAt(previous, f) ?? null])),
          after: Object.fromEntries(differs.map((f) => [f, valueAt(item, f) ?? null])),
        });
      }
    }
    const gone = complete ? saved.filter((r) => !r.removedAt && !keyed.has(r.key)) : [];

    if (!context.dryRun) {
      const now = new Date();
      await this.prisma.$transaction([
        ...[...keyed].map(([k, item]) =>
          this.prisma.dataRecord.upsert({
            where: { userId_collection_key: { userId, collection, key: k } },
            create: { userId, collection, key: k, value: item as Prisma.InputJsonValue, firstSeenAt: now, lastSeenAt: now },
            update: { value: item as Prisma.InputJsonValue, lastSeenAt: now, removedAt: null },
          }),
        ),
        this.prisma.dataRecord.updateMany({ where: { dataRecordId: { in: gone.map((r) => r.dataRecordId) } }, data: { removedAt: now } }),
      ]);
    }
    return { saved: keyed.size, created: added.length, skipped: items.length - keyed.size, added, changed, removed: gone.map((r) => r.value as Item) };
  }
}

/** An item's key as text (a string or a number); null without one. */
function keyOf(item: Item, path: string): string | null {
  const value = valueAt(item, path);
  const text = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  return text || null;
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

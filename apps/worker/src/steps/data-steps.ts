import { type Prisma, type PrismaClient } from "@realentity/storm-db";
import { canonicalJson, maskSealed, matchesAll, valueAt, type Condition } from "@realentity/storm-shared";
import { type StepContext, type StepExecutor } from "../runner/step-executor";
import { type CredentialVault } from "../secrets/credential-vault";
import { appType, saveEntities } from "./entity-steps";

export { valueAt };

type Item = Record<string, unknown>;

/**
 * data.dedupe: the first item per `key` value wins. Items without the key are all kept. With `againstType`, items whose
 * key is already an entity of that type of the pipeline's App go too: each comes through once; with `againstCollection`
 * (M71), those already saved in that list of the user's (data.save's `collection`, by its key).
 */
export class DedupeStep implements StepExecutor {
  readonly type = "data.dedupe";

  constructor(private readonly prisma?: PrismaClient) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { from, key, againstType, againstCollection } = input as { from: Item[]; key: string; againstType?: string; againstCollection?: string };
    const seen = new Set<string>();
    let items = from.filter((item) => {
      const value = valueAt(item, key);
      if (value === undefined || value === null) return true;
      const id = canonicalJson(value);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (againstCollection) {
      // Removed ones too: seen before is seen.
      if (!this.prisma) throw new Error("data.dedupe against a collection needs the database");
      const keys = items.map((item) => keyOf(item, key)).filter((k): k is string => k !== null);
      const saved = new Set(
        (
          await this.prisma.dataRecord.findMany({
            where: { userId: context.userId, collection: againstCollection, key: { in: keys } },
            select: { key: true },
          })
        ).map((r) => r.key),
      );
      items = items.filter((item) => {
        const k = keyOf(item, key);
        return k === null || !saved.has(k);
      });
    }
    if (againstType) {
      // M33: the items whose key is already an entity of the type (removed ones too: seen before is seen).
      if (!this.prisma) throw new Error("data.dedupe against a type needs the database");
      const { appId } = await appType(this.prisma, context, againstType);
      const keys = items.map((item) => valueAt(item, key)).filter((value): value is string => typeof value === "string");
      const saved = new Set(
        (await this.prisma.dataEntity.findMany({ where: { appId, type: againstType, key: { in: keys } }, select: { key: true } })).map((e) => e.key),
      );
      items = items.filter((item) => !saved.has(valueAt(item, key) as string));
    }
    return { items, duplicates: from.length - items.length };
  }
}

interface SaveInput {
  items: Item[];
  collection?: string;
  key?: string;
  fields?: string[];
  complete: boolean;
  type?: string;
  stage?: string;
}

interface Change {
  key: string;
  item: Item;
  before: Item;
  after: Item;
}

/**
 * data.save into a type of the pipeline's App (M30), or with `collection` (M13) into a list of the user's by `key`,
 * saying what was added, what changed and, for a complete list, what was removed since the last save. A dry run saves
 * nothing and says what it would have.
 */
export class SaveStep implements StepExecutor {
  readonly type = "data.save";

  constructor(
    private readonly prisma: PrismaClient,
    /** M46: where an App's files are, for file fields; without it, a file in an item is left out. */
    private readonly filesRoot?: string,
    /** M52: seals an App's encrypted fields. */
    private readonly vault?: CredentialVault,
  ) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const result = (await this.save(input as unknown as SaveInput, context)) as { saved: number; created: number };
    if (!context.dryRun) return result;
    // A dry run's counts are what a run would save: said first, so "saved 10" isn't read as done.
    const preview = `A dry run: nothing was saved. A run would save ${result.saved}, ${result.created} of them new.`;
    return { preview, ...result };
  }

  private async save(save: SaveInput, context: StepContext): Promise<unknown> {
    if (save.type) return saveEntities(this.prisma, { ...save, type: save.type }, context, this.filesRoot, this.vault);
    // M52: an encrypted field's value stays sealed only in an App's encrypted field; a list keeps ***.
    save = { ...save, items: maskSealed(save.items) };
    if (!save.collection) throw new Error("data.save needs `collection` or `type`");
    return this.intoCollection(save, save.collection, context);
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

/** data.filter: keeps items matching every condition. */
export class FilterStep implements StepExecutor {
  readonly type = "data.filter";

  execute(input: Record<string, unknown>): Promise<unknown> {
    const { items, where } = input as { items: Item[]; where: Condition[] };
    const kept = items.filter((item) => matchesAll(item, where));
    return Promise.resolve({ items: kept, removed: items.length - kept.length });
  }
}

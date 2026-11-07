import { type Prisma, type PrismaClient } from "@ai-me/db";
import { canMove, canonicalJson, checkEntity, entityItem, readAppSource, type AppDefinition, type DataType } from "@ai-me/shared";
import { type StepContext, type StepExecutor } from "../runner/step-executor";
import { matchesAll, valueAt, type Condition } from "./conditions";
import { contractProblems, JOB_ENTITY } from "@ai-me/steps";
import { emitStatus, STAGE_STATUS } from "./job-entities";

type Item = Record<string, unknown>;

/** The pipeline's App and one of its types, as its current version says (M30). */
export async function appType(
  prisma: PrismaClient,
  context: StepContext,
  typeName: string,
): Promise<{ appId: string; app: AppDefinition; type: DataType }> {
  if (!context.app) throw new Error(`${typeName} is an App's type, and this pipeline has no app:`);
  // M39-T3: by the id its version was saved with, so a renamed App is still found; by name before M39.
  const row = context.appId
    ? await prisma.app.findFirst({ where: { appId: context.appId, userId: context.userId } })
    : await prisma.app.findUnique({ where: { userId_name: { userId: context.userId, name: context.app } } });
  const version = row?.currentVersionId ? await prisma.appVersion.findUnique({ where: { appVersionId: row.currentVersionId } }) : null;
  if (!row || !version) throw new Error(`There is no App named "${context.app}"`);
  const app = readAppSource(version.source);
  const type = Object.hasOwn(app.types, typeName) ? app.types[typeName] : undefined;
  if (!type) throw new Error(`"${app.name}" has no type "${typeName}"`);
  return { appId: row.appId, app, type };
}

interface SaveEntitiesInput {
  items: Item[];
  type: string;
  fields?: string[];
  complete: boolean;
  /** Every item to this stage (M33: data.save { stage: skipped }), as the moves allow a pipeline. */
  stage?: string;
}

/** An entity's stage as a field of its item (M32); nothing for a type without stages. */
export function stageOf(type: DataType, stage: string | null) {
  return type.stages ? { field: type.stages.field, value: stage } : undefined;
}

/**
 * data.save { type } (M30): each item checked against its type (fields as their kinds, a wrong one left out, an item
 * without a required field not saved), kept by the type's key. Says what was added, changed and, for a complete
 * list, removed, as a collection does, and tells pipelines watching the type (entity.changed). My fields are never
 * written. With stages (M32), a new entity starts at `initial`, and the stage an item gives is taken only when a
 * move by: [pipeline] allows it (an email re-read never moves it back): otherwise it is said in `invalid`. A dry run
 * saves and tells nothing.
 */
export async function saveEntities(
  prisma: PrismaClient,
  { items, type: typeName, fields, complete, stage: everyStage }: SaveEntitiesInput,
  context: StepContext,
): Promise<unknown> {
  const { appId, app, type } = await appType(prisma, context, typeName);
  if (type.mine) throw new Error(`${typeName} is a type of mine: pipelines read it, only I write it`);
  const stages = type.stages;
  const invalid: { key: string | null; saved: boolean; problems: string[] }[] = [];
  const keyed = new Map<string, { value: Item; stage?: string }>();
  for (const item of items) {
    const checked = checkEntity(type, item);
    if (checked.problems.length > 0) invalid.push({ key: checked.key, saved: !checked.rejected, problems: checked.problems });
    if (checked.rejected || !checked.key) continue;
    // The stage isn't part of what pipelines write: it moves by the type's moves.
    const wanted = stages ? (everyStage ?? valueAt(checked.value, stages.field)) : undefined;
    if (stages) delete checked.value[stages.field];
    keyed.set(checked.key, { value: checked.value, ...(typeof wanted === "string" ? { stage: wanted } : {}) });
  }

  const saved = await prisma.dataEntity.findMany({
    where: complete ? { appId, type: typeName } : { appId, type: typeName, key: { in: [...keyed.keys()] } },
  });
  const before = new Map(saved.map((e) => [e.key, e]));
  const now = new Date();
  const added: Item[] = [];
  const changed: { key: string; item: Item; before: Item; after: Item }[] = [];
  const events: Record<string, unknown>[] = [];
  const writes: { key: string; value: Item; stage: string | null; stageDates: Record<string, string> }[] = [];
  for (const [key, { value, stage: wanted }] of keyed) {
    const old = before.get(key);
    const isNew = !old || old.removedAt !== null;
    const current = stages ? (old?.stage ?? stages.initial) : null;
    let stage = current;
    if (stages && wanted !== undefined && wanted !== current) {
      if (canMove(stages, current!, wanted, "pipeline")) stage = wanted;
      else invalid.push({ key, saved: true, problems: [`${stages.field} can't move from ${current} to ${wanted}`] });
    }
    const stageDates = { ...((old?.stageDates ?? {}) as Record<string, string>) };
    if (stage && !stageDates[stage]) stageDates[stage] = now.toISOString();
    const move = stage !== (old?.stage ?? null) && stage ? { from: old?.stage ?? null, to: stage } : null;
    writes.push({ key, value, stage, stageDates });
    const item = entityItem(value, old?.mine, stageOf(type, stage));

    if (isNew) {
      added.push(item);
      events.push({ key, item, before: null, changed: Object.keys(type.fields).filter((f) => valueAt(item, f) !== undefined && valueAt(item, f) !== null), stage: move });
      continue;
    }
    const previous = entityItem(old.value, old.mine, stageOf(type, old.stage));
    const compared = fields ?? [...new Set([...Object.keys(type.fields), ...Object.keys(old.value as Item), ...Object.keys(value)])];
    const differs = [...compared, ...(move && stages && !compared.includes(stages.field) ? [stages.field] : [])].filter(
      (f) => canonicalJson(valueAt(previous, f) ?? null) !== canonicalJson(valueAt(item, f) ?? null),
    );
    if (differs.length === 0) continue;
    changed.push({
      key,
      item,
      before: Object.fromEntries(differs.map((f) => [f, valueAt(previous, f) ?? null])),
      after: Object.fromEntries(differs.map((f) => [f, valueAt(item, f) ?? null])),
    });
    events.push({ key, item, before: previous, changed: differs, stage: move });
  }
  const gone = complete ? saved.filter((e) => !e.removedAt && !keyed.has(e.key)) : [];

  if (!context.dryRun) {
    await prisma.$transaction([
      ...writes.map(({ key, value, stage, stageDates }) =>
        prisma.dataEntity.upsert({
          where: { appId_type_key: { appId, type: typeName, key } },
          create: { appId, type: typeName, key, value: value as Prisma.InputJsonValue, stage, stageDates, firstSeenAt: now, lastSeenAt: now },
          update: { value: value as Prisma.InputJsonValue, stage, stageDates, lastSeenAt: now, removedAt: null },
        }),
      ),
      prisma.dataEntity.updateMany({ where: { dataEntityId: { in: gone.map((e) => e.dataEntityId) } }, data: { removedAt: now } }),
    ]);
    for (const event of events) {
      await context.emit?.("entity.changed", { app: app.name, appId, type: typeName, ...event, by: "pipeline" });
      // A Job reaching an application's stage still tells application.status (M33): its pipelines start on it.
      const move = event.stage as { to: string } | null;
      const isJob = typeName === JOB_ENTITY.type && contractProblems(type, JOB_ENTITY).length === 0;
      const saved = move && STAGE_STATUS[move.to] && isJob ? await prisma.dataEntity.findUnique({ where: { appId_type_key: { appId, type: typeName, key: event.key as string } } }) : null;
      if (saved && move) await emitStatus(context, saved, move.to, event.item as Item);
    }
  }
  return {
    saved: keyed.size,
    created: added.length,
    skipped: items.length - keyed.size,
    added,
    changed,
    removed: gone.map((e) => entityItem(e.value, e.mine, stageOf(type, e.stage))),
    invalid,
  };
}

/** Entities data.read gives at most, before `where` and `limit`. */
const READ_MAX = 5000;

/**
 * data.read (M30): entities of a type of the pipeline's App, as items with my fields, filtered by `where` (data.filter's
 * conditions), ordered by `sort` ("-salary", "@firstSeen"), capped by `limit`.
 */
export class ReadStep implements StepExecutor {
  readonly type = "data.read";

  constructor(private readonly prisma: PrismaClient) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const {
      type: typeName,
      where,
      sort,
      limit,
      removed,
    } = input as { type: string; where?: Condition[]; sort?: string; limit: number; removed: boolean };
    const { appId, type } = await appType(this.prisma, context, typeName);
    const rows = await this.prisma.dataEntity.findMany({
      where: { appId, type: typeName, removedAt: removed ? { not: null } : null },
      orderBy: { firstSeenAt: "desc" },
      take: READ_MAX,
    });
    let entities = rows.map((row) => ({ row, item: entityItem(row.value, row.mine, stageOf(type, row.stage)) }));
    if (where) entities = entities.filter(({ item }) => matchesAll(item, where));
    if (sort) {
      const by = sort.replace(/^-/, "");
      const desc = sort.startsWith("-");
      const valueOf = (e: (typeof entities)[number]): unknown =>
        by === "@firstSeen" ? e.row.firstSeenAt.toISOString() : by === "@lastSeen" ? e.row.lastSeenAt.toISOString() : valueAt(e.item, by);
      entities.sort((a, b) => order(valueOf(a), valueOf(b), desc));
    }
    return { items: entities.slice(0, limit).map((e) => e.item), count: entities.length };
  }
}

/** Numbers as numbers, the rest as text; a missing value last either way. */
function order(a: unknown, b: unknown, desc: boolean): number {
  const missing = (v: unknown) => v === undefined || v === null || v === "";
  if (missing(a) || missing(b)) return missing(a) === missing(b) ? 0 : missing(a) ? 1 : -1;
  const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  const result = typeof a === "number" && typeof b === "number" ? a - b : text(a).localeCompare(text(b));
  return desc ? -result : result;
}

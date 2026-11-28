import { type Prisma, type PrismaClient } from "@realentity/storm-db";
import { attachFiles, releaseFiles } from "@realentity/storm-files";
import {
  addedByHand,
  canMove,
  canonicalJson,
  caselessFields,
  checkEntity,
  comparableSealed,
  credentialAt,
  credentialFields,
  declaredOnly,
  encryptedFields,
  identifiedUses,
  entityItem,
  FILE_KINDS,
  fileRefId,
  inPlace,
  matchesAll,
  readAppSource,
  sealedAt,
  useProblems,
  valueAt,
  withTextLists,
  type AppDefinition,
  type AppUse,
  type Condition,
  type DataType,
  type SealedValue,
} from "@realentity/storm-shared";
import { type CredentialVault } from "../secrets/credential-vault";
import { type StepContext, type StepExecutor } from "../runner/step-executor";

type Item = Record<string, unknown>;

/** The pipeline's App and one of its types, as its current version says (M30). */
export async function appType(
  prisma: PrismaClient,
  context: StepContext,
  typeName: string,
): Promise<{ appId: string; app: AppDefinition; type: DataType }> {
  const { appId, app } = await pipelineApp(prisma, context, typeName);
  const type = Object.hasOwn(app.types, typeName) ? app.types[typeName] : undefined;
  if (!type) throw new Error(`"${app.name}" has no type "${typeName}"`);
  return { appId, app, type };
}

/** The pipeline's App as its current version says. */
async function pipelineApp(prisma: PrismaClient, context: StepContext, typeName: string): Promise<{ appId: string; app: AppDefinition }> {
  if (!context.app) throw new Error(`${typeName} is an App's type, and this pipeline has no app:`);
  // M39-T3: by the id its version was saved with, so a renamed App is still found; by name before M39.
  const row = context.appId
    ? await prisma.app.findFirst({ where: { appId: context.appId, userId: context.userId } })
    : await prisma.app.findUnique({ where: { userId_name: { userId: context.userId, name: context.app } } });
  const version = row?.currentVersionId ? await prisma.appVersion.findUnique({ where: { appVersionId: row.currentVersionId } }) : null;
  if (!row || !version) throw new Error(`There is no App named "${context.app}"`);
  return { appId: row.appId, app: readAppSource(version.source) };
}

/**
 * M66: a use of another App's type (`uses:`), as it is filled now: the user's App chosen for it (by id), its type,
 * and only if it still fits. Never another user's App; never one not chosen.
 */
async function usedType(
  prisma: PrismaClient,
  context: StepContext,
  appId: string,
  app: AppDefinition,
  name: string,
  use: AppUse,
): Promise<{ appId: string; typeName: string; type: DataType } | null> {
  const notChosen = () => {
    // An optional use not chosen reads nothing: the App works without it.
    if (use.optional) return null;
    throw new Error(`${name} isn't chosen yet: choose which of your Apps it comes from, on ${app.name}'s page`);
  };
  const chosen = await prisma.appUse.findUnique({ where: { appId_name: { appId, name } } });
  if (!chosen) return notChosen();
  const owner = await prisma.app.findFirst({ where: { appId: chosen.sourceAppId, userId: context.userId } });
  const version = owner?.currentVersionId ? await prisma.appVersion.findUnique({ where: { appVersionId: owner.currentVersionId } }) : null;
  if (!owner || !version) return notChosen();
  const definition = readAppSource(version.source);
  const type = Object.hasOwn(definition.types, chosen.sourceType) ? definition.types[chosen.sourceType] : undefined;
  const problems = type ? useProblems(use, type, identifiedUses(app).has(name)) : [`it has no type ${chosen.sourceType} any more`];
  if (!type || problems.length > 0) throw new Error(`${owner.name} › ${chosen.sourceType} no longer fits ${name}: ${problems.join("; ")}. Choose again on ${app.name}'s page`);
  return { appId: owner.appId, typeName: chosen.sourceType, type };
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
 * list, removed, as a collection does, and tells pipelines watching the type (entity.changed). The user's
 * (`mine`) fields are never written. With stages (M32), a new entity starts at `initial`, and the stage an item
 * gives is taken only when a move by: [pipeline] allows it (an email re-read never moves it back): otherwise it is
 * said in `invalid`. A dry run saves and tells nothing.
 */
export async function saveEntities(
  prisma: PrismaClient,
  { items, type: typeName, fields, complete, stage: everyStage }: SaveEntitiesInput,
  context: StepContext,
  filesRoot?: string,
  /** M52: seals encrypted fields; without it, an item giving one isn't saved. */
  vault?: CredentialVault,
): Promise<unknown> {
  const { appId, app, type } = await appType(prisma, context, typeName);
  if (type.mine) throw new Error(`${typeName} is a type of mine: pipelines read it, only the user writes it`);
  // M45: the App may have started adding by hand after the pipeline was saved; what I added would be marked removed.
  if (complete && addedByHand(app, typeName)) throw new Error(`${typeName} is added by hand too: a pipeline's list can't be complete`);
  const stages = type.stages;
  const invalid: { key: string | null; saved: boolean; problems: string[] }[] = [];
  const keyed = new Map<string, { value: Item; stage?: string }>();
  // M48: an update of an entity that has its required fields (one you added on its page, its title typed by you) needn't
  // give them again: what it holds counts.
  const required = Object.entries(type.fields).filter(([name, f]) => f.required && !f.mine && name !== type.key).map(([name]) => name);
  const rawKeys = items.flatMap((item) => {
    const key = valueAt(item, type.key);
    return typeof key === "string" || typeof key === "number" ? [String(key)] : [];
  });
  const holding = new Map(
    required.length > 0 && rawKeys.length > 0
      ? (await prisma.dataEntity.findMany({ where: { appId, type: typeName, key: { in: rawKeys } } })).map((e) => [e.key, entityItem(e.value, e.mine)])
      : [],
  );
  for (const given of items) {
    const rawKey = valueAt(given, type.key);
    const held = typeof rawKey === "string" || typeof rawKey === "number" ? holding.get(String(rawKey)) : undefined;
    const item = held ? { ...given } : given;
    if (held) {
      for (const name of required) {
        const value = valueAt(item, name);
        if ((value === undefined || value === null || value === "") && valueAt(held, name) !== undefined) item[name] = valueAt(held, name);
      }
    }
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
  const fileFields = Object.entries(type.fields).flatMap(([name, f]) => (FILE_KINDS.includes(f.type) ? [name] : []));
  for (const [key, { value, stage: wanted }] of keyed) {
    const old = before.get(key);
    // M46: a file field: a file file.keep kept for this type and field (attached now), never another entity's; a save
    // without it keeps the one there, so a re-read of the source never loses a receipt.
    for (const name of fileFields) {
      if (valueAt(value, name) === undefined) {
        const kept = old ? valueAt(old.value as Item, name) : undefined;
        if (kept !== undefined && kept !== null) value[name] = kept;
        continue;
      }
      const attached = filesRoot && !context.dryRun ? await attachOne(prisma, { appId, type: typeName, key }, value, name) : dryFile(value, name, filesRoot);
      if (attached === null) {
        delete value[name];
        invalid.push({ key, saved: true, problems: [`${name} isn't a file file.keep kept for ${typeName}.${name}`] });
      }
    }
    // M52: an encrypted field sealed for this entity; a save without it keeps the one there, as a file field.
    for (const name of encryptedFields(type)) {
      const given = value[name];
      const held = old ? (old.value as Item)[name] : undefined;
      if (given === undefined) {
        if (held !== undefined && held !== null) value[name] = held;
        continue;
      }
      if (!vault) throw new Error(`${typeName}.${name} is encrypted, and this worker has no key to seal it`);
      value[name] = vault.sealFor(sealedAt(appId, typeName, key, name), given as string | SealedValue, held);
    }
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
      (f) => canonicalJson(comparableSealed(valueAt(previous, f) ?? null)) !== canonicalJson(comparableSealed(valueAt(item, f) ?? null)),
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
    if (fileFields.length > 0 && filesRoot) {
      for (const { key, value } of writes) await releaseFiles(prisma, filesRoot, { appId, type: typeName, key }, value, before.get(key)?.mine);
    }
    for (const event of events) await context.emit?.("entity.changed", { app: app.name, appId, type: typeName, ...event, by: "pipeline" });
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
 * data.read (M30): entities of a type of the pipeline's App, as items with the user's fields, filtered by `where` (data.filter's
 * conditions), ordered by `sort` ("-salary", "@firstSeen"), capped by `limit`.
 */
export class ReadStep implements StepExecutor {
  readonly type = "data.read";

  constructor(
    private readonly prisma: PrismaClient,
    /** M57: seals a credential field's id as a handle; without it the field is left out. */
    private readonly vault?: CredentialVault,
  ) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const {
      type: typeName,
      where,
      sort,
      limit,
      removed,
      stageDates,
    } = input as { type: string; where?: Condition[]; sort?: string; limit: number; removed: boolean; stageDates: boolean };
    const own = await pipelineApp(this.prisma, context, typeName);
    // M66: another App's type this App uses: read where it is kept, only its declared fields.
    const use = Object.hasOwn(own.app.uses ?? {}, typeName) ? own.app.uses![typeName] : undefined;
    if (use) return this.readUse(context, own, typeName, use, { where, sort, limit, removed });
    const { appId } = own;
    const type = Object.hasOwn(own.app.types, typeName) ? own.app.types[typeName] : undefined;
    if (!type) throw new Error(`"${own.app.name}" has no type "${typeName}"`);
    const rows = await this.prisma.dataEntity.findMany({
      where: { appId, type: typeName, removedAt: removed ? { not: null } : null },
      orderBy: { firstSeenAt: "desc" },
      take: READ_MAX,
    });
    // M52: an encrypted field as its sealed value (a handle), only when it is this entity's.
    const sealed = encryptedFields(type);
    const credentials = credentialFields(type);
    const entities = rows.map((row) => ({
      row,
      item: this.withCredentials(
        inPlace(withTextLists(type, entityItem(row.value, row.mine, stageOf(type, row.stage))), sealed, (field) =>
          sealedAt(appId, typeName, row.key, field),
        ),
        credentials,
        (field) => credentialAt(appId, typeName, row.key, field),
      ),
    }));
    // M71: when each first reached each stage (an outcome: an interview that ended in a rejection was still one).
    if (stageDates && type.stages) for (const { row, item } of entities) item["@stages"] = { ...(row.stageDates as Record<string, string>) };
    return narrowed(entities, type, { where, sort, limit });
  }

  /**
   * M66: a use read from the App chosen for it: its entities with only the declared fields (none encrypted, a
   * credential or a file: such a type doesn't fit), filtered and sorted on them as the App's own are.
   */
  private async readUse(
    context: StepContext,
    own: { appId: string; app: AppDefinition },
    name: string,
    use: AppUse,
    query: { where?: Condition[]; sort?: string; limit: number; removed: boolean },
  ): Promise<unknown> {
    const used = await usedType(this.prisma, context, own.appId, own.app, name, use);
    if (!used) return { items: [], count: 0 };
    const { appId, typeName, type } = used;
    const rows = await this.prisma.dataEntity.findMany({
      where: { appId, type: typeName, removedAt: query.removed ? { not: null } : null },
      orderBy: { firstSeenAt: "desc" },
      take: READ_MAX,
    });
    const entities = rows.map((row) => ({ row, item: declaredOnly(withTextLists(type, entityItem(row.value, row.mine, stageOf(type, row.stage))), use.fields) }));
    return narrowed(entities, type, query);
  }

  /**
   * M57: a credential field as a handle to it: its id sealed where it belongs, so only the worker opens it, and only
   * as a request sends it to a host the credential allows. Never its secret: that stays in the vault.
   */
  private withCredentials(
    item: Record<string, unknown>,
    fields: readonly string[],
    at: (field: string) => string,
  ): Record<string, unknown> {
    for (const field of fields) {
      const id = item[field];
      if (typeof id === "string" && this.vault) item[field] = this.vault.sealFor(at(field), id);
      else delete item[field];
    }
    return item;
  }
}

/** data.read's `where`, `sort` and `limit` over the entities read; `count` before the limit. */
function narrowed(
  read: { row: { firstSeenAt: Date; lastSeenAt: Date }; item: Item }[],
  type: DataType,
  query: { where?: Condition[]; sort?: string; limit: number },
): { items: Item[]; count: number } {
  // M65: a list of text matches its values without case unless it is caseSensitive (a tag "Home" is "home").
  const caseless = caselessFields(type);
  const entities = query.where ? read.filter(({ item }) => matchesAll(item, query.where!, { caseless })) : [...read];
  if (query.sort) {
    const by = query.sort.replace(/^-/, "");
    const desc = query.sort.startsWith("-");
    const valueOf = (e: (typeof entities)[number]): unknown =>
      by === "@firstSeen" ? e.row.firstSeenAt.toISOString() : by === "@lastSeen" ? e.row.lastSeenAt.toISOString() : valueAt(e.item, by);
    entities.sort((a, b) => order(valueOf(a), valueOf(b), desc));
  }
  return { items: entities.slice(0, query.limit).map((e) => e.item), count: entities.length };
}

/** Numbers as numbers, the rest as text; a missing value last either way. */
function order(a: unknown, b: unknown, desc: boolean): number {
  const missing = (v: unknown) => v === undefined || v === null || v === "";
  if (missing(a) || missing(b)) return missing(a) === missing(b) ? 0 : missing(a) ? 1 : -1;
  const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  const result = typeof a === "number" && typeof b === "number" ? a - b : text(a).localeCompare(text(b));
  return desc ? -result : result;
}

/** M46: one file field of an item attached: its reference, or null when it isn't one file.keep kept for it. */
async function attachOne(prisma: PrismaClient, where: { appId: string; type: string; key: string }, value: Item, field: string): Promise<unknown> {
  try {
    const attached = await attachFiles(prisma, where, { [field]: (value[field] as { id?: string })?.id ?? null }, [field], () => {
      throw new Refused();
    });
    if (!attached[field]) return null;
    value[field] = attached[field];
    return attached[field];
  } catch (error) {
    if (error instanceof Refused) return null;
    throw error;
  }
}

class Refused extends Error {}

/** A dry run attaches nothing: a reference is shown as it came; without the App's files, none is taken. */
function dryFile(value: Item, field: string, filesRoot: string | undefined): unknown {
  if (!filesRoot) return null;
  return fileRefId(value[field]) ? value[field] : null;
}

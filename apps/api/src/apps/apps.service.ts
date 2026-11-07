import { Prisma } from "@ai-me/db";
import {
  checkAppSource,
  definitionToSource,
  entityValueAt,
  readAppSource,
  type AddFieldRequest,
  type AppCheckRequest,
  type AppCheckView,
  type AppDefinition,
  type AppDetailView,
  type AppDriftView,
  type AppIssue,
  type AppSaveRefusal,
  type AppSummaryView,
  type CompiledDefinition,
  type DataType,
  type DraftTypeRequest,
  type DraftTypeView,
  type EntityListView,
  type EntityQuery,
} from "@ai-me/shared";
import { diffApps, draftField, draftType, leafValues, PipelineCompiler, type CompileContext } from "@ai-me/steps";
import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { parse as parseYaml, parseDocument, stringify } from "yaml";
import { PrismaService } from "../database/prisma.service";
import { AppImportsService } from "./app-imports.service";

type Item = Record<string, unknown>;

/**
 * Apps (M30): what belongs together, with its data types. Versioned like pipelines; a save that would break one of
 * its pipelines (a type, field or name they use gone) is refused, naming each. Pipelines are compiled against their
 * App's current version through `contextFor`.
 */
@Injectable()
export class AppsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly compiler: PipelineCompiler,
    private readonly imports: AppImportsService,
  ) {}

  /** The App a pipeline names (`app:`), for the compiler; nothing for a pipeline outside any App. */
  async contextFor(userId: string, pipeline: unknown): Promise<CompileContext> {
    const name = pipeline && typeof pipeline === "object" ? (pipeline as { app?: unknown }).app : undefined;
    if (typeof name !== "string") return {};
    const app = await this.currentDefinition(userId, name.trim());
    return app ? { app } : {};
  }

  /**
   * M34-T4: what the entities' sources give that their types don't name: a draft field each (in at least two
   * entities), the most common first.
   */
  async drift(userId: string, appId: string): Promise<AppDriftView[]> {
    const app = await this.prisma.client.app.findFirst({ where: { appId, userId } });
    const version = app?.currentVersionId
      ? await this.prisma.client.appVersion.findUnique({ where: { appVersionId: app.currentVersionId } })
      : null;
    if (!app || !version) throw new NotFoundException();
    const definition = readAppSource(version.source);
    const drift: AppDriftView[] = [];
    for (const [typeName, type] of Object.entries(definition.types)) {
      if (type.mine) continue;
      const rows = await this.prisma.client.dataEntity.findMany({
        where: { appId, type: typeName, removedAt: null },
        select: { value: true },
        orderBy: { lastSeenAt: "desc" },
        take: 1000,
      });
      const fields = new Map<string, unknown[]>();
      for (const row of rows) {
        for (const [name, values] of leafValues(row.value as Item)) {
          if (name in type.fields || Object.keys(type.fields).some((f) => name.startsWith(`${f}.`))) continue;
          fields.set(name, [...(fields.get(name) ?? []), ...values]);
        }
      }
      for (const [field, values] of fields) {
        const suggested = draftField(values);
        if (!suggested || values.length < 2) continue;
        const examples = [...new Set(values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))))]
          .slice(0, 3)
          .map((v) => v.slice(0, 80));
        drift.push({ type: typeName, field, count: values.length, suggested, examples });
      }
    }
    return drift.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type) || a.field.localeCompare(b.field));
  }

  /** M34-T4: one of them added to its type, as the next version (my comments in the YAML kept). */
  async addField(userId: string, appId: string, { type, field }: AddFieldRequest): Promise<AppDetailView> {
    const found = (await this.drift(userId, appId)).find((d) => d.type === type && d.field === field);
    if (!found) throw new NotFoundException(`${type} has no "${field}" to add`);
    const app = await this.prisma.client.app.findFirstOrThrow({ where: { appId, userId } });
    const version = await this.prisma.client.appVersion.findUniqueOrThrow({ where: { appVersionId: app.currentVersionId! } });
    const document = parseDocument(version.source);
    const { required: _, mine: __, ...authored } = found.suggested;
    document.setIn(["types", type, "fields", field], document.createNode(authored, { flow: true }));
    return this.save(userId, appId, document.toString({ lineWidth: 0 }));
  }

  /** M34: my Apps as they are, for the builder. */
  async definitions(userId: string): Promise<AppDefinition[]> {
    const apps = await this.prisma.client.app.findMany({ where: { userId, currentVersionId: { not: null } }, orderBy: { name: "asc" } });
    const versions = await this.prisma.client.appVersion.findMany({
      where: { appVersionId: { in: apps.map((a) => a.currentVersionId!) } },
    });
    return versions.map((v) => readAppSource(v.source));
  }

  /** M34: an App's id, name, current YAML and its pipelines' current definitions, for a chat about it. */
  async forBuilder(userId: string, appId: string): Promise<{ name: string; source: string; pipelines: CompiledDefinition[] }> {
    const app = await this.prisma.client.app.findFirst({ where: { appId, userId } });
    const version = app?.currentVersionId
      ? await this.prisma.client.appVersion.findUnique({ where: { appVersionId: app.currentVersionId } })
      : null;
    if (!app || !version) throw new NotFoundException();
    const pipelines = await this.prisma.client.pipeline.findMany({ where: { userId, currentVersionId: { not: null } } });
    const versions = await this.prisma.client.pipelineVersion.findMany({
      where: { pipelineVersionId: { in: pipelines.map((p) => p.currentVersionId!) } },
    });
    const definitions = versions.map((v) => v.definition as unknown as CompiledDefinition).filter((d) => d.app === app.name);
    return { name: app.name, source: version.source, pipelines: definitions };
  }

  /** M34: the App of that name, with its id and current version's definition; null when there is none. */
  async byName(userId: string, name: string): Promise<{ appId: string; definition: AppDefinition } | null> {
    const app = await this.prisma.client.app.findUnique({ where: { userId_name: { userId, name } } });
    if (!app?.currentVersionId) return null;
    const version = await this.prisma.client.appVersion.findUnique({ where: { appVersionId: app.currentVersionId } });
    return version ? { appId: app.appId, definition: readAppSource(version.source) } : null;
  }

  /** M34: a pipeline's source compiled against an App not saved yet. */
  compileWith(source: string, app: AppDefinition) {
    return Promise.resolve(this.compiler.compileText(source, { app }));
  }

  /** Pipeline source as YAML, compiled against its App. */
  async compileSource(userId: string, source: string) {
    let parsed: unknown;
    try {
      parsed = parseYaml(source);
    } catch {
      return this.compiler.compileText(source);
    }
    return this.compiler.compile(parsed, await this.contextFor(userId, parsed));
  }

  async list(userId: string): Promise<AppSummaryView[]> {
    const apps = await this.prisma.client.app.findMany({ where: { userId }, orderBy: { name: "asc" } });
    const pipelines = await this.pipelinesByApp(userId);
    const versions = await this.prisma.client.appVersion.findMany({
      where: { appVersionId: { in: apps.flatMap((a) => (a.currentVersionId ? [a.currentVersionId] : [])) } },
    });
    const counts = await this.prisma.client.dataEntity.groupBy({
      by: ["appId", "type"],
      where: { appId: { in: apps.map((a) => a.appId) }, removedAt: null },
      _count: { _all: true },
    });
    return apps.map((app) => {
      const version = versions.find((v) => v.appVersionId === app.currentVersionId);
      const definition = version ? readAppSource(version.source) : undefined;
      return {
        appId: app.appId,
        name: app.name,
        icon: definition?.icon ?? "list",
        version: version?.version ?? null,
        types: Object.keys(definition?.types ?? {}).map((name) => ({
          name,
          entities: counts.find((c) => c.appId === app.appId && c.type === name)?._count._all ?? 0,
        })),
        pipelines: pipelines.get(app.name) ?? [],
      };
    });
  }

  async get(userId: string, appId: string): Promise<AppDetailView> {
    const app = await this.prisma.client.app.findFirst({
      where: { appId, userId },
      include: { versions: { orderBy: { version: "desc" } } },
    });
    if (!app) throw new NotFoundException();
    const current = app.versions.find((v) => v.appVersionId === app.currentVersionId);
    if (!current) throw new NotFoundException();
    const definition = readAppSource(current.source);
    const summary = (await this.list(userId)).find((a) => a.appId === appId)!;
    return {
      ...summary,
      definition,
      imports: await this.imports.available(userId, definition),
      source: current.source,
      versions: app.versions.map((v) => ({ version: v.version, changeSummary: v.changeSummary, dateCreated: v.dateCreated.toISOString() })),
    };
  }

  async create(userId: string, source: string): Promise<AppDetailView> {
    const definition = parseApp(source);
    const appId = await this.unique(() =>
      this.prisma.client.$transaction(async (tx) => {
        const app = await tx.app.create({ data: { userId, name: definition.name } });
        const version = await tx.appVersion.create({ data: { appId: app.appId, version: 1, definition: toJson(definition), source } });
        await tx.app.update({ where: { appId: app.appId }, data: { currentVersionId: version.appVersionId } });
        return app.appId;
      }),
    );
    return this.get(userId, appId);
  }

  /**
   * The next version. Every pipeline of the App (by its old name) is compiled against it first: one that no longer
   * compiles refuses the save, named with its errors.
   */
  async save(userId: string, appId: string, source: string): Promise<AppDetailView> {
    const definition = parseApp(source);
    const app = await this.prisma.client.app.findFirst({ where: { appId, userId } });
    const current = app?.currentVersionId
      ? await this.prisma.client.appVersion.findUnique({ where: { appVersionId: app.currentVersionId } })
      : null;
    if (!app || !current) throw new NotFoundException();
    const changes = diffApps(readAppSource(current.source), definition);
    if (changes.length === 0) throw new UnprocessableEntityException("No changes compared to the current version");

    const broken = await this.brokenPipelines(userId, app.name, definition);
    if (broken.length > 0) {
      const refusal: AppSaveRefusal = {
        message: `It would break ${broken.length === 1 ? `"${broken[0].name}"` : `${broken.length} pipelines`}: change ${broken.length === 1 ? "it" : "them"} first, or keep what they use`,
        errors: broken.flatMap((p) => p.errors.map((e) => ({ path: `${p.name}: ${e.path || "(pipeline)"}`, message: e.message }))),
        pipelines: broken,
      };
      throw new ConflictException(refusal);
    }
    await this.unique(() =>
      this.prisma.client.$transaction(async (tx) => {
        const version = await tx.appVersion.create({
          data: { appId, version: current.version + 1, definition: toJson(definition), source, changeSummary: changes.join("\n") },
        });
        await tx.app.update({ where: { appId }, data: { currentVersionId: version.appVersionId, name: definition.name } });
      }),
    );
    return this.get(userId, appId);
  }

  /**
   * M35-T1: a draft checked as I edit it, nothing saved: its problems with their lines; of an App's draft, also its
   * pipelines compiled against it (what Save would refuse) and what it changes.
   */
  async check(userId: string, { source, appId }: AppCheckRequest): Promise<AppCheckView> {
    const app = appId ? await this.prisma.client.app.findFirst({ where: { appId, userId } }) : null;
    if (appId && !app) throw new NotFoundException();
    const { definition, errors } = checkAppSource(source);
    if (!definition) return { ok: false, errors, pipelines: [], changes: [] };
    const current = app?.currentVersionId
      ? await this.prisma.client.appVersion.findUnique({ where: { appVersionId: app.currentVersionId } })
      : null;
    const pipelines = await this.brokenPipelines(userId, app?.name ?? definition.name, definition);
    const changes = current ? diffApps(readAppSource(current.source), definition) : [];
    return { ok: pipelines.length === 0, errors: [], pipelines, changes };
  }

  async entities(userId: string, appId: string, typeName: string, query: EntityQuery): Promise<EntityListView> {
    const app = await this.prisma.client.app.findFirst({ where: { appId, userId } });
    const version = app?.currentVersionId
      ? await this.prisma.client.appVersion.findUnique({ where: { appVersionId: app.currentVersionId } })
      : null;
    const definition = version ? readAppSource(version.source) : undefined;
    const dataType: DataType | undefined = definition && Object.hasOwn(definition.types, typeName) ? definition.types[typeName] : undefined;
    if (!app || !definition || !dataType) throw new NotFoundException();
    const where = { appId, type: typeName, removedAt: query.removed ? { not: null } : null };
    const [rows, total] = await Promise.all([
      this.prisma.client.dataEntity.findMany({ where, orderBy: { firstSeenAt: "desc" }, skip: query.offset, take: query.limit }),
      this.prisma.client.dataEntity.count({ where }),
    ]);
    return {
      app: definition.name,
      type: typeName,
      dataType,
      total,
      entities: rows.map((row) => ({
        key: row.key,
        value: row.value as Item,
        mine: row.mine as Item,
        firstSeenAt: row.firstSeenAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
        removedAt: row.removedAt?.toISOString() ?? null,
      })),
    };
  }

  /**
   * M30-T7: a type drafted from what a step of a run gave (a dry run of the source): its list of objects (`field`, or
   * the first one), across every item of a forEach step; without one, the list it was given.
   */
  async draftType(userId: string, { runId, stepKey, field }: DraftTypeRequest): Promise<DraftTypeView> {
    const run = await this.prisma.client.run.findFirst({ where: { runId, userId }, select: { runId: true } });
    if (!run) throw new NotFoundException();
    const steps = await this.prisma.client.step.findMany({ where: { runId, stepKey, status: "DONE" }, orderBy: { itemIndex: "asc" } });
    if (steps.length === 0) throw new NotFoundException(`"${stepKey}" has no output in this run`);
    const objects = (values: unknown[]) => values.filter((o): o is Item => !!o && typeof o === "object" && !Array.isArray(o));
    const listOf = (records: Item[]) => {
      const name = field ?? Object.keys(records[0] ?? {}).find((n) => records.some((o) => isObjectList(o[n])));
      return name ? records.flatMap((o) => (isObjectList(o[name]) ? o[name] : [])) : [];
    };
    // What the step gave; else what it was given (data.save's items, when they were all saved before).
    const outputs = objects(steps.map((s) => s.output as unknown));
    const fromOutput = listOf(outputs);
    const items = fromOutput.length > 0 ? fromOutput : listOf(objects(steps.map((s) => s.input as unknown)));
    return drafted(items.length > 0 ? items : outputs);
  }

  /** M35-T4: a type drafted from a sample I paste: its list of items (the first one in it), or the one item it is. */
  draftTypeFromSample(sample: unknown): DraftTypeView {
    const items = Array.isArray(sample)
      ? sample.filter((o): o is Item => !!o && typeof o === "object" && !Array.isArray(o))
      : sample && typeof sample === "object"
        ? (Object.values(sample).find(isObjectList) ?? [sample as Item])
        : [];
    return drafted(items);
  }

  /** M35-T5: the pipelines naming the App (by its name now) that wouldn't compile against this definition, but these. */
  async brokenBy(userId: string, name: string, definition: AppDefinition, except: string[] = []) {
    return (await this.brokenPipelines(userId, name, definition)).filter((p) => !except.includes(p.name));
  }

  private async brokenPipelines(userId: string, name: string, definition: AppDefinition) {
    const pipelines = await this.prisma.client.pipeline.findMany({ where: { userId, currentVersionId: { not: null } } });
    const versions = await this.prisma.client.pipelineVersion.findMany({
      where: { pipelineVersionId: { in: pipelines.map((p) => p.currentVersionId!) } },
    });
    const broken: { pipelineId: string; name: string; errors: AppIssue[] }[] = [];
    for (const version of versions) {
      const compiled = version.definition as unknown as CompiledDefinition;
      if (compiled.app !== name) continue;
      const result = this.compiler.compileText(definitionToSource(compiled), { app: definition });
      if (!result.ok) {
        const pipeline = pipelines.find((p) => p.pipelineId === version.pipelineId)!;
        broken.push({ pipelineId: pipeline.pipelineId, name: pipeline.name, errors: result.errors });
      }
    }
    return broken;
  }

  /** Saved pipelines by the App they name. */
  private async pipelinesByApp(userId: string) {
    const pipelines = await this.prisma.client.pipeline.findMany({
      where: { userId, currentVersionId: { not: null } },
      orderBy: { name: "asc" },
    });
    const versions = await this.prisma.client.pipelineVersion.findMany({
      where: { pipelineVersionId: { in: pipelines.map((p) => p.currentVersionId!) } },
      select: { pipelineVersionId: true, definition: true },
    });
    const byApp = new Map<string, { pipelineId: string; name: string; enabled: boolean }[]>();
    for (const pipeline of pipelines) {
      const app = (
        versions.find((v) => v.pipelineVersionId === pipeline.currentVersionId)?.definition as unknown as CompiledDefinition | undefined
      )?.app;
      if (!app) continue;
      byApp.set(app, [...(byApp.get(app) ?? []), { pipelineId: pipeline.pipelineId, name: pipeline.name, enabled: pipeline.enabled }]);
    }
    return byApp;
  }

  private async currentDefinition(userId: string, name: string): Promise<AppDefinition | null> {
    const app = await this.prisma.client.app.findUnique({ where: { userId_name: { userId, name } } });
    if (!app?.currentVersionId) return null;
    const version = await this.prisma.client.appVersion.findUnique({ where: { appVersionId: app.currentVersionId } });
    return version ? readAppSource(version.source) : null;
  }

  /** Two Apps can't share a name: their pipelines name them. */
  private async unique<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("There is already an App with this name");
      }
      throw error;
    }
  }
}

function parseApp(source: string): AppDefinition {
  const { definition, errors } = checkAppSource(source);
  if (definition) return definition;
  const refusal: AppSaveRefusal = { message: errors.some((e) => !e.path) ? "The App isn't valid YAML" : "The App isn't valid", errors };
  throw new BadRequestException(refusal);
}

/** The draft from items, with a few of each field's values. */
function drafted(items: Item[]): DraftTypeView {
  const type = draftType(items);
  if (!type) throw new UnprocessableEntityException("Nothing to draft from: no list of items, or no field that tells them apart");
  const examples: Record<string, string[]> = {};
  for (const name of Object.keys(type.fields)) {
    const values = items.map((item) => entityValueAt(item, name)).filter((v) => v !== undefined && v !== null && v !== "");
    examples[name] = [...new Set(values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))))]
      .slice(0, 3)
      .map((v) => v.slice(0, 80));
  }
  return { type, samples: items.length, source: stringify({ Item: authoredType(type) }, { lineWidth: 0 }), examples };
}

/** A type as I'd write it: without the defaults (required: false, mine: false). */
function authoredType(type: DataType): Item {
  return {
    ...(type.description ? { description: type.description } : {}),
    key: type.key,
    ...(type.title ? { title: type.title } : {}),
    fields: Object.fromEntries(
      Object.entries(type.fields).map(([name, field]) => [
        name,
        {
          type: field.type,
          ...(field.label ? { label: field.label } : {}),
          ...(field.required ? { required: true } : {}),
          ...(field.mine ? { mine: true } : {}),
          ...(field.values ? { values: field.values } : {}),
          ...(field.currency ? { currency: field.currency } : {}),
        },
      ]),
    ),
  };
}

function isObjectList(value: unknown): value is Item[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => v && typeof v === "object" && !Array.isArray(v));
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

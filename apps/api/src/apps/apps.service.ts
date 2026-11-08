import { Prisma } from "@ai-me/db";
import {
  appMap,
  withCurrentNames,
  withCurrentRuns,
  type CurrentNames,
  namedPipelines,
  type AppRefs,
  type DefinitionRefs,
  type AppMapView,
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
import { diffApps, draftField, draftType, leafValues, PipelineCompiler, StepCatalog, type CompileContext } from "@ai-me/steps";
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
    private readonly catalog: StepCatalog,
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
    const names = await this.currentNames(userId);
    const definitions = versions
      .map((v) => ({ v, definition: v.definition as unknown as CompiledDefinition }))
      .filter(({ definition }) => belongsTo(definition, app.appId, app.name))
      .map(({ v, definition }) => withCurrentNames(definition, names, pipelines.find((p) => p.pipelineId === v.pipelineId)?.name));
    return { name: app.name, source: withCurrentRuns(version.source, version.refs as AppRefs | null, names), pipelines: definitions };
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
    const result = this.compiler.compile(parsed, await this.contextFor(userId, parsed));
    if (result.ok) {
      // M39-T2: what it names, by id; a pipeline it names that isn't there yet is a warning, found by name when it runs.
      const { refs, missing } = await this.refsOf(userId, result.definition);
      result.definition.refs = refs;
      for (const name of missing) {
        result.warnings.push({ path: "", message: `There is no pipeline named "${name}" yet: it is looked up by name when this runs` });
      }
    }
    return result;
  }

  /**
   * M39-T5: what refers to a pipeline, by id: other pipelines (their run.finished trigger, a flow.later step) and Apps'
   * buttons, as their current versions say.
   */
  async referrersOf(userId: string, pipelineId: string): Promise<string[]> {
    const pipelines = await this.prisma.client.pipeline.findMany({ where: { userId, currentVersionId: { not: null }, pipelineId: { not: pipelineId } } });
    const versions = await this.prisma.client.pipelineVersion.findMany({ where: { pipelineVersionId: { in: pipelines.map((p) => p.currentVersionId!) } } });
    const followers: string[] = [];
    for (const pipeline of pipelines) {
      const definition = versions.find((v) => v.pipelineVersionId === pipeline.currentVersionId)?.definition as unknown as CompiledDefinition | undefined;
      const names = Object.entries(definition?.refs?.pipelines ?? {}).filter(([, id]) => id === pipelineId).map(([name]) => name);
      if (names.length === 0 || !definition) continue;
      const how = namedPipelines({ trigger: definition.trigger, steps: [] }).some((n) => names.includes(n)) ? "its trigger" : "a flow.later step";
      followers.push(`"${pipeline.name}" (${how})`);
    }
    const apps = await this.prisma.client.app.findMany({ where: { userId, currentVersionId: { not: null } } });
    const appVersions = await this.prisma.client.appVersion.findMany({ where: { appVersionId: { in: apps.map((a) => a.currentVersionId!) } } });
    for (const app of apps) {
      const refs = appVersions.find((v) => v.appVersionId === app.currentVersionId)?.refs as AppRefs | null | undefined;
      if (Object.values(refs?.pipelines ?? {}).includes(pipelineId)) followers.push(`a button of "${app.name}"`);
    }
    return followers;
  }

  /** M39-T4: the names my Apps and saved pipelines have now, by id: what a definition is shown with. */
  async currentNames(userId: string): Promise<CurrentNames> {
    const [apps, pipelines] = await Promise.all([
      this.prisma.client.app.findMany({ where: { userId }, select: { appId: true, name: true } }),
      this.prisma.client.pipeline.findMany({ where: { userId, currentVersionId: { not: null } }, select: { pipelineId: true, name: true } }),
    ]);
    return {
      apps: Object.fromEntries(apps.map((a) => [a.appId, a.name])),
      pipelines: Object.fromEntries(pipelines.map((p) => [p.pipelineId, p.name])),
    };
  }

  /** M39-T2: the App and the saved pipelines a definition names, by id. */
  async refsOf(userId: string, definition: CompiledDefinition): Promise<{ refs: DefinitionRefs; missing: string[] }> {
    const app = definition.app ? await this.prisma.client.app.findUnique({ where: { userId_name: { userId, name: definition.app } } }) : null;
    const names = namedPipelines(definition);
    const found = names.length
      ? await this.prisma.client.pipeline.findMany({ where: { userId, name: { in: names }, currentVersionId: { not: null } } })
      : [];
    const pipelines = Object.fromEntries(found.map((p) => [p.name, p.pipelineId]));
    return { refs: { ...(app ? { appId: app.appId } : {}), pipelines }, missing: names.filter((n) => !(n in pipelines)) };
  }

  /** M39-T2: the pipelines an App's buttons run (its pages' actions), by id; those not saved yet are left to their name. */
  async appRefsOf(userId: string, definition: AppDefinition): Promise<AppRefs> {
    const names = [...new Set(definition.pages.flatMap((p) => ("actions" in p ? p.actions.map((a) => a.run) : [])))];
    const found = names.length
      ? await this.prisma.client.pipeline.findMany({ where: { userId, name: { in: names }, currentVersionId: { not: null } } })
      : [];
    return { pipelines: Object.fromEntries(found.map((p) => [p.name, p.pipelineId])) };
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
        example: (app.example as { id?: string } | null)?.id ?? null,
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
    // M39-T4: its buttons' pipelines under their names now.
    const source = withCurrentRuns(current.source, current.refs as AppRefs | null, await this.currentNames(userId));
    const definition = readAppSource(source);
    const summary = (await this.list(userId)).find((a) => a.appId === appId)!;
    return {
      ...summary,
      definition,
      imports: await this.imports.available(userId, definition, appId),
      source,
      versions: app.versions.map((v) => ({ version: v.version, changeSummary: v.changeSummary, dateCreated: v.dateCreated.toISOString() })),
    };
  }

  /** M37-T4: the App's map: what starts its pipelines, what they write and read, its pages and their buttons. */
  async map(userId: string, appId: string): Promise<AppMapView> {
    const detail = await this.get(userId, appId);
    const ids = detail.pipelines.map((p) => p.pipelineId);
    const pipelines = await this.prisma.client.pipeline.findMany({ where: { pipelineId: { in: ids } } });
    const versions = await this.prisma.client.pipelineVersion.findMany({
      where: { pipelineVersionId: { in: pipelines.flatMap((p) => (p.currentVersionId ? [p.currentVersionId] : [])) } },
      select: { pipelineVersionId: true, definition: true },
    });
    const entities = Object.fromEntries(detail.types.map((t) => [t.name, t.entities]));
    return appMap(
      detail.definition,
      detail.pipelines.flatMap((p) => {
        const current = pipelines.find((x) => x.pipelineId === p.pipelineId)?.currentVersionId;
        const version = versions.find((v) => v.pipelineVersionId === current);
        return version ? [{ ...p, definition: version.definition as unknown as CompiledDefinition }] : [];
      }),
      entities,
      (type) => this.catalog.get(type)?.entities ?? [],
    );
  }

  async create(userId: string, source: string): Promise<AppDetailView> {
    const definition = parseApp(source);
    const refs = toJson(await this.appRefsOf(userId, definition));
    const appId = await this.unique(() =>
      this.prisma.client.$transaction(async (tx) => {
        const app = await tx.app.create({ data: { userId, name: definition.name } });
        const version = await tx.appVersion.create({ data: { appId: app.appId, version: 1, definition: toJson(definition), source, refs } });
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

    const broken = await this.brokenPipelines(userId, app.appId, app.name, definition);
    if (broken.length > 0) {
      const refusal: AppSaveRefusal = {
        message: `It would break ${broken.length === 1 ? `"${broken[0].name}"` : `${broken.length} pipelines`}: change ${broken.length === 1 ? "it" : "them"} first, or keep what they use`,
        errors: broken.flatMap((p) => p.errors.map((e) => ({ path: `${p.name}: ${e.path || "(pipeline)"}`, message: e.message }))),
        pipelines: broken,
      };
      throw new ConflictException(refusal);
    }
    const refs = toJson(await this.appRefsOf(userId, definition));
    await this.unique(() =>
      this.prisma.client.$transaction(async (tx) => {
        const version = await tx.appVersion.create({
          data: { appId, version: current.version + 1, definition: toJson(definition), source, changeSummary: changes.join("\n"), refs },
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
    const pipelines = await this.brokenPipelines(userId, app?.appId ?? null, app?.name ?? definition.name, definition);
    const changes = current ? diffApps(readAppSource(current.source), definition) : [];
    // M39-T5: a rename says what follows it.
    const renamed =
      app && definition.name !== app.name
        ? { from: app.name, to: definition.name, followers: (await this.forBuilder(userId, app.appId)).pipelines.map((p) => p.name).sort((a, b) => a.localeCompare(b)) }
        : undefined;
    return { ok: pipelines.length === 0, errors: [], pipelines, changes, ...(renamed ? { renamed } : {}) };
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
    const app = await this.prisma.client.app.findUnique({ where: { userId_name: { userId, name } } });
    return (await this.brokenPipelines(userId, app?.appId ?? null, name, definition)).filter((p) => !except.includes(p.name));
  }

  /**
   * The App's pipelines (M39-T3: by the id their version was saved with, else by name) compiled against a version of
   * it; under its new name when it is renamed, as the pipelines will then show it (M39-T4).
   */
  private async brokenPipelines(userId: string, appId: string | null, name: string, definition: AppDefinition) {
    const pipelines = await this.prisma.client.pipeline.findMany({ where: { userId, currentVersionId: { not: null } } });
    const versions = await this.prisma.client.pipelineVersion.findMany({
      where: { pipelineVersionId: { in: pipelines.map((p) => p.currentVersionId!) } },
    });
    const broken: { pipelineId: string; name: string; errors: AppIssue[] }[] = [];
    for (const version of versions) {
      const compiled = version.definition as unknown as CompiledDefinition;
      if (!belongsTo(compiled, appId, name)) continue;
      const result = this.compiler.compileText(definitionToSource({ ...compiled, app: definition.name }), { app: definition });
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
    const appNames = new Map((await this.prisma.client.app.findMany({ where: { userId } })).map((a) => [a.appId, a.name]));
    const byApp = new Map<string, { pipelineId: string; name: string; enabled: boolean }[]>();
    for (const pipeline of pipelines) {
      const compiled = versions.find((v) => v.pipelineVersionId === pipeline.currentVersionId)?.definition as unknown as
        | CompiledDefinition
        | undefined;
      // M39-T3: the App its version was saved with, by id (renamed since, it is under its name now); else by name.
      const app = compiled?.refs?.appId ? appNames.get(compiled.refs.appId) : compiled?.app;
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

/** M39-T3: is a saved pipeline one of the App's? By the id its version was saved with, else (before M39) by name. */
function belongsTo(definition: CompiledDefinition, appId: string | null, name: string): boolean {
  return definition.refs?.appId && appId ? definition.refs.appId === appId : definition.app === name;
}

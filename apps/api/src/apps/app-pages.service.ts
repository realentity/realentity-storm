import { type DataEntity } from "@realentity/storm-db";
import {
  actionApplies,
  caselessFields,
  isTextList,
  CHART_SERIES,
  checkAppSource,
  declaredOnly,
  PREVIEW_ROWS,
  sampleRows,
  entityItem,
  entityValueAt,
  isMineField,
  movesFrom,
  fieldOf,
  groupValue,
  isRefField,
  listPageOf,
  readAppSource,
  reportOf,
  reportPageOf,
  reportPagesOf,
  viewPageOf,
  withTextLists,
  isDayFilter,
  defaultTimeZone,
  distinctValues,
  filterMatches,
  filterValues,
  sourceItems,
  type SourceView,
  type AppDefinition,
  type AppUseChoiceView,
  type AppEntityView,
  type AppReportView,
  type AppListQueryParsed,
  type AppListView,
  type AppMenuItem,
  type AppMenuPage,
  type AppPageHeader,
  type AppPreviewRequest,
  type AppPreviewView,
  type DataType,
  type EntityGroup,
  type PageFilter,
  type ResolvedListPage,
  type ViewChart,
  type ViewRow,
} from "@realentity/storm-shared";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { nothingOn, pipelinesByApp } from "./app-pipelines";
import { AppUsesService, type ChosenUse } from "./app-uses.service";

/** A list reads at most this many entities of its type, the newest first; filtered, sorted and grouped in memory. */
const MAX_ROWS = 5000;

/**
 * An App's pages (M31): a list per type (filters, search, groups with totals) and an entity's own page, as the App's
 * `pages` say or by default from its fields. Every value is shown as text by the web app.
 */
@Injectable()
export class AppPagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uses: AppUsesService,
  ) {}

  /**
   * Every App for the launcher, by name: its lists that go in the menu (its types in the order they are written), then
   * its reports, whether anything of it runs by itself, and how many of its pipelines' proposals wait for a decision.
   */
  async menu(userId: string): Promise<AppMenuItem[]> {
    const apps = await this.prisma.client.app.findMany({ where: { userId, currentVersionId: { not: null } }, orderBy: { name: "asc" } });
    const versions = await this.prisma.client.appVersion.findMany({
      where: { appVersionId: { in: apps.map((a) => a.currentVersionId!) } },
    });
    const pipelines = await pipelinesByApp(this.prisma.client, userId);
    const waiting = await this.prisma.client.proposal.findMany({
      where: { userId, status: "PENDING_REVIEW" },
      select: { run: { select: { pipelineVersion: { select: { pipelineId: true } } } } },
    });
    return apps.flatMap((app) => {
      const version = versions.find((v) => v.appVersionId === app.currentVersionId);
      if (!version) return [];
      const definition = readAppSource(version.source);
      const own = pipelines.get(app.name) ?? [];
      const ids = new Set(own.map((p) => p.pipelineId));
      const page = (kind: AppMenuPage["kind"], p: { type: string; label: string; icon: AppMenuPage["icon"] }): AppMenuPage => ({
        kind,
        type: p.type,
        label: p.label,
        icon: p.icon,
      });
      return [
        {
          appId: app.appId,
          name: definition.name,
          icon: definition.icon,
          description: definition.description ?? null,
          pages: [
            ...Object.keys(definition.types)
              .map((type) => listPageOf(definition, type))
              .filter((p) => p.menu)
              .map((p) => page("list", p)),
            ...reportPagesOf(definition).map((p) => page("report", p)),
          ],
          nothingOn: nothingOn(own),
          pending: waiting.filter((w) => ids.has(w.run.pipelineVersion.pipelineId)).length,
          pinned: app.pinned,
        },
      ];
    });
  }

  /** Pins an App to the sidebar, or takes it off. */
  async pin(userId: string, appId: string, pinned: boolean): Promise<void> {
    const { count } = await this.prisma.client.app.updateMany({ where: { appId, userId }, data: { pinned } });
    if (count === 0) throw new NotFoundException("No such App");
  }

  /** A type's report over the last `days` ("all": all time; left out: its first period), of its entities as its list reads them. */
  async report(userId: string, appId: string, type: string, picked: number | "all" | undefined): Promise<AppReportView> {
    const { header, definition } = await this.header(userId, appId, type);
    const page = reportPageOf(definition, type);
    if (!page) throw new NotFoundException(`"${definition.name}" has no report of ${type}`);
    const days = picked === "all" ? null : (picked ?? page.periods[0]);
    const entities = await this.prisma.client.dataEntity.findMany({ where: { appId, type }, orderBy: { firstSeenAt: "desc" }, take: MAX_ROWS });
    const rows = await this.withTitles(
      userId,
      appId,
      definition,
      type,
      entities.map((e) => rowOf(e, definition.types[type])),
    );
    const report = reportOf(
      page,
      rows.map((row, i) => ({ row, stageDates: (entities[i].stageDates ?? {}) as Record<string, string> })),
      days,
    );
    return { ...header, page, days, ...report };
  }

  async list(userId: string, appId: string, type: string, query: AppListQueryParsed): Promise<AppListView> {
    const { header, definition } = await this.header(userId, appId, type);
    const rows = await this.withTitles(userId, appId, definition, type, await this.rows(appId, definition, type));
    // M65: the rows of the other types the page's sources read; M66: of a use, the chosen App's (none until chosen).
    const read = new Map<string, ViewRow[]>([[type, rows]]);
    const sourced = new Map<string, SourceOf>();
    const sources = Object.values(listPageOf(definition, type).sources);
    const used = sources.some((s) => !Object.hasOwn(definition.types, s.from)) ? await this.uses.chosen(userId, appId, definition) : new Map<string, ChosenUse>();
    for (const source of sources) {
      if (sourced.has(source.from)) continue;
      const use = used.get(source.from);
      if (Object.hasOwn(definition.types, source.from)) {
        sourced.set(source.from, { type: definition.types[source.from], title: listPageOf(definition, source.from).title });
        if (!read.has(source.from)) read.set(source.from, await this.withTitles(userId, appId, definition, source.from, await this.rows(appId, definition, source.from)));
      } else if (use) {
        sourced.set(source.from, { type: use.type, title: use.title });
        read.set(source.from, await this.useRows(use));
      }
    }
    const listed = listOf(definition, type, rows, query, (from) => read.get(from) ?? [], (from) => sourced.get(from));
    const chart = listed.page.chart ? await this.chart(userId, listed.page.chart.history, rows, listed.page.title) : null;
    // M55: a ref filter's values are the entities of its type.
    const filters = await this.withRefValues(userId, appId, definition, listed.page.filters);
    return { ...header, ...listed, page: { ...listed.page, filters }, chart };
  }

  /**
   * M37-T2: a page of a draft App with the App's entities of the type (when the draft still has it by that name), else
   * with a few made up from its fields; and the first row's own page. Nothing is saved; a chart isn't drawn.
   */
  async preview(userId: string, request: AppPreviewRequest): Promise<AppPreviewView> {
    const { definition, errors } = checkAppSource(request.source);
    if (!definition) throw new BadRequestException(errors[0]?.message ?? "The App has problems");
    if (!Object.hasOwn(definition.types, request.type)) throw new NotFoundException(`"${definition.name}" has no type "${request.type}"`);
    let rows: ViewRow[] = [];
    let version = 0;
    if (request.appId) {
      const app = await this.prisma.client.app.findFirst({ where: { appId: request.appId, userId } });
      if (!app) throw new NotFoundException();
      rows = (await this.rows(app.appId, definition, request.type)).filter((r) => !r.removedAt);
      version = (await this.prisma.client.appVersion.count({ where: { appId: app.appId } })) + 1;
    }
    const sample = rows.length === 0;
    if (sample) rows = sampleRows(request.type, definition.types[request.type]);
    const listed = listOf(
      definition,
      request.type,
      rows,
      { tab: "current", filter: {}, offset: 0, limit: PREVIEW_ROWS },
      (from) => (from === request.type ? rows : []),
      (from) => (Object.hasOwn(definition.types, from) ? { type: definition.types[from], title: listPageOf(definition, from).title } : undefined),
    );
    const first = listed.rows[0];
    return {
      list: { appId: request.appId ?? "", app: definition.name, version, type: request.type, ...listed, chart: null },
      view: first ? { page: viewPageOf(definition, request.type), row: first } : null,
      sample,
    };
  }

  private async rows(appId: string, definition: AppDefinition, type: string): Promise<ViewRow[]> {
    const entities = await this.prisma.client.dataEntity.findMany({
      where: { appId, type },
      orderBy: { firstSeenAt: "desc" },
      take: MAX_ROWS,
    });
    return entities.map((e) => rowOf(e, definition.types[type]));
  }

  /** M66: a use's rows: the chosen App's entities of its type that are there, with only the declared fields. */
  private async useRows(use: ChosenUse): Promise<ViewRow[]> {
    const entities = await this.prisma.client.dataEntity.findMany({
      where: { appId: use.appId, type: use.typeName, removedAt: null },
      orderBy: { firstSeenAt: "desc" },
      take: MAX_ROWS,
    });
    return entities.map((e) => {
      const row = rowOf(e, use.type);
      return { ...row, value: declaredOnly(row.value, use.fields) };
    });
  }

  /** M66: a ref's choices through a use: the chosen App's entities, by key, named by their title; none until chosen. */
  async useChoices(userId: string, appId: string, name: string): Promise<AppUseChoiceView[]> {
    const { definition } = await this.current(userId, appId);
    if (!definition.uses || !Object.hasOwn(definition.uses, name)) throw new NotFoundException(`"${definition.name}" has no use "${name}"`);
    const use = (await this.uses.chosen(userId, appId, definition)).get(name);
    return use ? choicesOf(await this.useRows(use), use.title) : [];
  }

  /** M33 (M29-T8's, for an App): every key's values, the CHART_SERIES with the highest latest value, named by their entity. */
  private async chart(userId: string, collection: string, rows: ViewRow[], title: string): Promise<ViewChart> {
    const points = await this.prisma.client.dataPoint.findMany({
      where: { userId, collection },
      orderBy: { at: "asc" },
      select: { key: true, at: true, value: true },
    });
    const byKey = new Map<string, { at: string; value: number }[]>();
    for (const p of points) byKey.set(p.key, [...(byKey.get(p.key) ?? []), { at: p.at.toISOString(), value: p.value }]);
    const titles = new Map(rows.map((r) => [r.key, fieldOf(r, title)]));
    const series = [...byKey]
      .map(([key, values]) => {
        const name = titles.get(key);
        return { key, label: typeof name === "string" || typeof name === "number" ? String(name) : key, points: values };
      })
      .sort((a, b) => b.points.at(-1)!.value - a.points.at(-1)!.value);
    return { series: series.slice(0, CHART_SERIES), more: Math.max(0, series.length - CHART_SERIES) };
  }

  async entity(userId: string, appId: string, type: string, key: string): Promise<AppEntityView> {
    const { header, definition } = await this.header(userId, appId, type);
    const entity = await this.prisma.client.dataEntity.findUnique({ where: { appId_type_key: { appId, type, key } } });
    if (!entity) throw new NotFoundException();
    const viewed = viewPageOf(definition, type);
    // M55: the related lists' ref filters, filled in like a list's.
    const page = {
      ...viewed,
      related: await Promise.all(
        viewed.related.map(async (r) => ({ ...r, filters: await this.withRefValues(userId, appId, definition, r.filters) })),
      ),
    };
    const list = listPageOf(definition, type);
    const history = page.history
      ? (
          await this.prisma.client.dataPoint.findMany({
            where: { userId, collection: page.history.collection, key },
            orderBy: { at: "asc" },
            select: { at: true, value: true },
          })
        ).map((p) => ({ at: p.at.toISOString(), value: p.value }))
      : null;
    const dataType = definition.types[type];
    const [row] = await this.withTitles(userId, appId, definition, type, [rowOf(entity, dataType)]);
    const stages = dataType.stages;
    const current = stages ? (entity.stage ?? stages.initial) : null;
    return {
      ...header,
      list: { label: list.label, title: list.title },
      page,
      row,
      history,
      stage: stages
        ? { value: current, moves: movesFrom(stages, current!, "me"), dates: entity.stageDates as Record<string, string> }
        : null,
      mine: (entity.mine ?? {}) as Record<string, unknown>,
      written: writtenUnder(dataType, page.form, entity.value, entity.mine),
      actions: page.actions.flatMap((action, i) => (actionApplies(action, row.value, entityValueAt) ? [i] : [])),
      referencedBy: await this.referencedBy(appId, definition, type, key),
    };
  }

  /** M55: the entities of each type that point at this one (a ref field of theirs holding its key), counted. */
  async referencedBy(
    appId: string,
    definition: AppDefinition,
    type: string,
    key: string,
  ): Promise<{ type: string; label: string; count: number }[]> {
    const found: { type: string; label: string; count: number }[] = [];
    for (const [name, other] of Object.entries(definition.types)) {
      const fields = Object.entries(other.fields)
        .filter(([, f]) => isRefField(f) && f.to === type)
        .map(([f]) => f);
      if (fields.length === 0) continue;
      const rows = await this.rows(appId, definition, name);
      const count = rows.filter((r) => !r.removedAt && fields.some((f) => pointsAt(fieldOf(r, f), key))).length;
      if (count > 0) found.push({ type: name, label: listPageOf(definition, name).label, count });
    }
    return found;
  }

  /** M55: a ref filter's values: the entities of its type, by key, named by their title; M66: of a use, the chosen App's. */
  private async withRefValues(userId: string, appId: string, definition: AppDefinition, filters: PageFilter[]): Promise<PageFilter[]> {
    const uses = definition.uses ?? {};
    const used = filters.some((f) => f.ref && Object.hasOwn(uses, f.ref)) ? await this.uses.chosen(userId, appId, definition) : new Map<string, ChosenUse>();
    return Promise.all(
      filters.map(async (f) => {
        if (!f.ref) return f;
        if (Object.hasOwn(uses, f.ref)) {
          const use = used.get(f.ref);
          return { ...f, values: use ? choicesOf(await this.useRows(use), use.title) : [] };
        }
        if (!Object.hasOwn(definition.types, f.ref)) return f;
        const rows = (await this.rows(appId, definition, f.ref)).filter((r) => !r.removedAt);
        return { ...f, values: choicesOf(rows, listPageOf(definition, f.ref).title) };
      }),
    );
  }

  /**
   * M56: the rows with what their ref fields point at named: each by its title (a list of refs: theirs, in order).
   * One that points at nothing any more is left out (its key is shown).
   */
  private async withTitles(userId: string, appId: string, definition: AppDefinition, type: string, rows: ViewRow[]): Promise<ViewRow[]> {
    const fields = Object.entries(definition.types[type].fields);
    const uses = definition.uses ?? {};
    const refs = fields.filter(([, f]) => isRefField(f) && f.to && (Object.hasOwn(definition.types, f.to) || Object.hasOwn(uses, f.to)));
    // M57: a credential field by the credential's name.
    const credentials = fields.filter(([, f]) => f.type === "credential").map(([name]) => name);
    if (refs.length === 0 && credentials.length === 0) return rows;
    const names =
      credentials.length > 0
        ? new Map(
            (await this.prisma.client.credential.findMany({ where: { userId }, select: { credentialId: true, name: true } })).map((c) => [
              c.credentialId,
              c.name,
            ]),
          )
        : new Map<string, string>();
    const titles = new Map<string, Map<string, string>>();
    // M66: a ref to a use is named by the chosen App's entity (none until chosen: its key is shown).
    const used = refs.some(([, f]) => Object.hasOwn(uses, f.to!)) ? await this.uses.chosen(userId, appId, definition) : new Map<string, ChosenUse>();
    for (const to of new Set(refs.map(([, f]) => f.to!))) {
      if (Object.hasOwn(uses, to)) {
        const use = used.get(to);
        titles.set(to, new Map(use ? choicesOf(await this.useRows(use), use.title).map((c) => [c.value, c.label]) : []));
        continue;
      }
      const title = listPageOf(definition, to).title;
      const theirs = await this.rows(appId, definition, to);
      titles.set(to, new Map(theirs.filter((r) => !r.removedAt).map((r) => [r.key, text(fieldOf(r, title)) ?? r.key])));
    }
    return rows.map((row) => {
      const named: Record<string, string> = {};
      for (const [name, field] of refs) {
        const of = titles.get(field.to!)!;
        const value = fieldOf(row, name);
        const keys = Array.isArray(value) ? value.map((v) => text(v) ?? "") : [text(value) ?? ""];
        if (keys.length > 0 && keys.every((k) => of.has(k))) named[name] = keys.map((k) => of.get(k)!).join(", ");
      }
      for (const name of credentials) {
        const id = text(fieldOf(row, name));
        if (id) named[name] = names.get(id) ?? "A credential that is gone";
      }
      return Object.keys(named).length > 0 ? { ...row, titles: named } : row;
    });
  }

  private async header(userId: string, appId: string, type: string): Promise<{ header: AppPageHeader; definition: AppDefinition }> {
    const { version, definition } = await this.current(userId, appId);
    if (!Object.hasOwn(definition.types, type)) throw new NotFoundException(`"${definition.name}" has no type "${type}"`);
    return { header: { appId, app: definition.name, version, type }, definition };
  }

  /** The user's App as its current version says. */
  private async current(userId: string, appId: string): Promise<{ version: number; definition: AppDefinition }> {
    const app = await this.prisma.client.app.findFirst({ where: { appId, userId } });
    const version = app?.currentVersionId
      ? await this.prisma.client.appVersion.findUnique({ where: { appVersionId: app.currentVersionId } })
      : null;
    if (!app || !version) throw new NotFoundException();
    return { version: version.version, definition: readAppSource(version.source) };
  }
}

/** M65: what a page's source reads: its type (M66: a use's, narrowed to its fields) and the field that is its title. */
interface SourceOf {
  type: DataType;
  title: string;
}

/**
 * A type's rows as its list page shows them: the tab's, filtered, searched, sorted, in groups with totals, then paged;
 * M65: with what its sources return (`rowsOf`: a source's rows; `sourceOf`: its type, none for a use not chosen).
 */
function listOf(
  definition: AppDefinition,
  type: string,
  rows: ViewRow[],
  query: AppListQueryParsed,
  rowsOf: (from: string) => ViewRow[],
  sourceOf: (from: string) => SourceOf | undefined,
): Omit<AppListView, keyof AppPageHeader | "chart"> {
  const resolved = listPageOf(definition, type);
  const dataType = definition.types[type];
  // Days in the instance's time zone (TZ).
  const zone = defaultTimeZone();
  const counts = { current: rows.filter((r) => !r.removedAt).length, removed: rows.filter((r) => r.removedAt).length };
  const wanted = Object.entries(query.filter).map(([field, value]) => [field, filterValues(value)] as const);
  for (const [field, values] of wanted) {
    // M55: any ref field too: an entity's page lists what points at it.
    const isRef = dataType?.fields[field]?.type === "ref";
    const filter = resolved.filters.find((f) => f.field === field);
    if (!isRef && !filter) throw new BadRequestException(`This page has no filter "${field}"`);
    if (filter?.match === "day" && values.some((v) => !isDayFilter(v)))
      throw new BadRequestException(`"${field}" is filtered by a day (2026-11-25) or a range (2026-11-01..2026-11-30)`);
  }
  const q = query.q?.toLowerCase();
  const inTab = rows.filter((row) => (query.tab === "removed") === (row.removedAt !== null));
  const searched = inTab.filter(
    (row) =>
      !q ||
      row.key.toLowerCase().includes(q) ||
      resolved.search.some((f) => (row.titles?.[f] ?? searchText(fieldOf(row, f)))?.toLowerCase().includes(q)),
  );
  // M65: each filter by its field's type; filters and search together (AND).
  const passes = (row: ViewRow, except?: string) =>
    wanted.every(([field, values]) => field === except || filterMatches(dataType, field, row, values, zone));
  const matching = searched.filter((row) => passes(row));
  const current = rows.filter((r) => !r.removedAt);
  // M65: a list's filter picks among the values in use.
  const page: ResolvedListPage = {
    ...resolved,
    filters: resolved.filters.map((f) =>
      f.match === "contains" && !f.ref ? { ...f, values: distinctValues(dataType, f.field, false, current, zone).map(({ value, label }) => ({ value, label })) } : f,
    ),
  };
  const sources = Object.fromEntries(
    Object.entries(resolved.sources).map(([name, source]): [string, SourceView] => {
      const of = sourceOf(source.from);
      if ("distinct" in source) {
        if (!of) return [name, { kind: "values", field: source.distinct, values: [] }];
        // On the page's own type, what the other filters and the search leave (a tag's count among the days picked).
        const over = source.from === type ? searched.filter((row) => passes(row, source.distinct)) : rowsOf(source.from).filter((r) => !r.removedAt);
        return [name, { kind: "values", field: source.distinct, values: distinctValues(of.type, source.distinct, source.by === "day", over, zone) }];
      }
      const items = of ? sourceItems(of.type, source, rowsOf(source.from).filter((r) => !r.removedAt), { title: of.title }) : [];
      return [name, { kind: "items", items }];
    }),
  );
  matching.sort((a, b) => compare(fieldOf(a, page.sort.by), fieldOf(b, page.sort.by), page.sort.desc));

  let groups: EntityGroup[] | null = null;
  let shown = matching;
  if (page.group) {
    const { by, period } = page.group;
    const byField = dataType?.fields[by.field];
    if (byField && isTextList(byField)) {
      // M65-T8: a list field's groups: a row under each of its values (a task under each tag), one without under "No …".
      const spelling = listSpellings(dataType, by.field, matching);
      const valuesOf = (row: ViewRow): (string | null)[] => {
        const values = [...new Set(listTexts(fieldOf(row, by.field)).map((v) => spelling(v)))];
        return values.length > 0 ? values : [null];
      };
      const placed = matching.flatMap((row) => valuesOf(row).map((group) => ({ ...row, group })));
      const order = groupOrder(definition, page, placed.map((r) => r.group));
      groups = order.map((value) => ({
        ...groupOf(
          page,
          value,
          placed.filter((row) => row.group === value),
        ),
        ...(value === null ? { label: `No ${by.label.toLowerCase()}` } : {}),
      }));
      placed.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
      shown = placed;
    } else {
      const valueOf = (row: ViewRow) => groupValue(fieldOf(row, by.field), period);
      const order = groupOrder(definition, page, matching.map(valueOf));
      groups = order.map((value) =>
        groupOf(
          page,
          value,
          matching.filter((row) => valueOf(row) === value),
        ),
      );
      // Rows by group, each group in the page's sort (a stable sort keeps it).
      matching.sort((a, b) => order.indexOf(valueOf(a)) - order.indexOf(valueOf(b)));
    }
  }
  return { page, rows: shown.slice(query.offset, query.offset + query.limit), total: shown.length, counts, groups, sources };
}

/** A ref's choices: the rows by key, named by their title (else the key), by name. */
function choicesOf(rows: ViewRow[], title: string): AppUseChoiceView[] {
  return rows
    .filter((r) => !r.removedAt)
    .map((r) => ({ value: r.key, label: text(fieldOf(r, title)) ?? r.key }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** A list's values as text. */
function listTexts(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).map(text).filter((v): v is string => v !== null && v !== "");
}

/** M65-T8: a list of text matched without case groups its spellings as one: the first one seen names it. */
function listSpellings(type: DataType | undefined, field: string, rows: ViewRow[]): (value: string) => string {
  if (!type || !caselessFields(type).has(field)) return (value) => value;
  const first = new Map<string, string>();
  for (const row of rows) for (const value of listTexts(fieldOf(row, field))) if (!first.has(value.toLowerCase())) first.set(value.toLowerCase(), value);
  return (value) => first.get(value.toLowerCase()) ?? value;
}

/** An entity as a row: what pipelines wrote, with the user's fields over it, and its stage. */
function rowOf(entity: DataEntity, type: DataType): ViewRow {
  return {
    key: entity.key,
    value: withTextLists(
      type,
      entityItem(entity.value, entity.mine, type.stages ? { field: type.stages.field, value: entity.stage ?? type.stages.initial } : undefined),
    ),
    marks: {},
    firstSeenAt: entity.firstSeenAt.toISOString(),
    lastSeenAt: entity.lastSeenAt.toISOString(),
    removedAt: entity.removedAt?.toISOString() ?? null,
  };
}

/**
 * Groups in order: an enum's values as written, yes before no, months and years newest first, anything else
 * alphabetically; entities without a value last.
 */
function groupOrder(app: AppDefinition, page: ResolvedListPage, values: (string | null)[]): (string | null)[] {
  const distinct = [...new Set(values)];
  const field = app.types[page.type]?.fields[page.group!.by.field];
  const rank = (value: string): number => {
    if (field?.type === "enum") return field.values?.indexOf(value) ?? 0;
    if (field?.type === "yesno") return value === "Yes" ? 0 : 1;
    return 0;
  };
  const newestFirst = page.group!.period !== null;
  return distinct.sort((a, b) => {
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
    return rank(a) - rank(b) || (newestFirst ? b.localeCompare(a) : a.localeCompare(b, "en", { numeric: true }));
  });
}

function groupOf(page: ResolvedListPage, value: string | null, rows: ViewRow[]): EntityGroup {
  const totals = page.group!.totals.map((total) => {
    const sums: Record<string, number> = {};
    const counted = total.when ? rows.filter((row) => actionApplies({ when: total.when }, row.value, entityValueAt)) : rows;
    for (const row of counted) {
      const amount = fieldOf(row, total.field);
      if (typeof amount !== "number") continue;
      const currency = total.currency ? (text(fieldOf(row, total.currency)) ?? "") : "";
      sums[currency] = Math.round(((sums[currency] ?? 0) + amount) * 100) / 100;
    }
    return { field: total.field, sums };
  });
  return { value, label: value ?? "—", count: rows.length, totals };
}

/** M55: a ref holding the key; M56: a list of refs holding it. */
function pointsAt(value: unknown, key: string): boolean {
  return Array.isArray(value) ? value.some((v) => text(v) === key) : text(value) === key;
}

/** A value as filters and search compare it: text, numbers and yes/no as text. */
/** M65: what search looks in: a value as text, a list's values (a memo's tags) one after another. */
function searchText(value: unknown): string | null {
  if (!Array.isArray(value)) return text(value);
  const texts = value.map(text).filter((v): v is string => v !== null);
  return texts.length > 0 ? texts.join("\n") : null;
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** Numbers as numbers, the rest as text; a missing value last either way. */
function compare(a: unknown, b: unknown, desc: boolean): number {
  const missing = (v: unknown) => v === undefined || v === null || v === "";
  if (missing(a) || missing(b)) return missing(a) === missing(b) ? 0 : missing(a) ? 1 : -1;
  const result =
    typeof a === "number" && typeof b === "number" ? a - b : (text(a) ?? JSON.stringify(a)).localeCompare(text(b) ?? JSON.stringify(b));
  return desc ? -result : result;
}

/** M45: what pipelines wrote under each form field the user set, when pipelines may write it and wrote something. */
function writtenUnder(type: DataType, form: { field: string }[], value: unknown, mine: unknown): Record<string, unknown> {
  const set = (mine ?? {}) as Record<string, unknown>;
  const written = (value ?? {}) as Record<string, unknown>;
  return Object.fromEntries(
    form.flatMap(({ field }) => {
      if (!(field in set) || isMineField(type, field)) return [];
      const under = entityValueAt(written, field);
      return under === undefined || under === null ? [] : [[field, under]];
    }),
  );
}

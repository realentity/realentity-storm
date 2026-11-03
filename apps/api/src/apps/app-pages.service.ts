import { type DataEntity } from "@ai-me/db";
import {
  actionApplies,
  CHART_SERIES,
  entityItem,
  entityValueAt,
  movesFrom,
  fieldOf,
  groupValue,
  listPageOf,
  readAppSource,
  viewPageOf,
  type AppDefinition,
  type AppEntityView,
  type AppListQueryParsed,
  type AppListView,
  type AppMenuItem,
  type AppPageHeader,
  type DataType,
  type EntityGroup,
  type ResolvedListPage,
  type ViewChart,
  type ViewRow,
} from "@ai-me/shared";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

/** A list reads at most this many entities of its type, the newest first; filtered, sorted and grouped in memory. */
const MAX_ROWS = 5000;

/**
 * An App's pages (M31): a list per type (filters, search, groups with totals) and an entity's own page, as the App's
 * `pages` say or by default from its fields. Every value is shown as text by the web app.
 */
@Injectable()
export class AppPagesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every App's lists that go in the menu, by App, each App's types in the order I wrote them. */
  async menu(userId: string): Promise<AppMenuItem[]> {
    const apps = await this.prisma.client.app.findMany({ where: { userId, currentVersionId: { not: null } }, orderBy: { name: "asc" } });
    const versions = await this.prisma.client.appVersion.findMany({
      where: { appVersionId: { in: apps.map((a) => a.currentVersionId!) } },
    });
    return apps.flatMap((app) => {
      const version = versions.find((v) => v.appVersionId === app.currentVersionId);
      if (!version) return [];
      const definition = readAppSource(version.source);
      return Object.keys(definition.types)
        .map((type) => listPageOf(definition, type))
        .filter((page) => page.menu)
        .map((page) => ({ appId: app.appId, appName: definition.name, type: page.type, label: page.label, icon: page.icon }));
    });
  }

  async list(userId: string, appId: string, type: string, query: AppListQueryParsed): Promise<AppListView> {
    const { header, definition } = await this.header(userId, appId, type);
    const page = listPageOf(definition, type);
    const entities = await this.prisma.client.dataEntity.findMany({
      where: { appId, type },
      orderBy: { firstSeenAt: "desc" },
      take: MAX_ROWS,
    });
    const dataType = definition.types[type];
    const rows = entities.map((e) => rowOf(e, dataType));
    const counts = { current: rows.filter((r) => !r.removedAt).length, removed: rows.filter((r) => r.removedAt).length };

    for (const field of Object.keys(query.filter)) {
      if (!page.filters.some((f) => f.field === field)) throw new BadRequestException(`This page has no filter "${field}"`);
    }
    const q = query.q?.toLowerCase();
    const matching = rows.filter(
      (row) =>
        (query.tab === "removed") === (row.removedAt !== null) &&
        Object.entries(query.filter).every(([field, value]) => text(fieldOf(row, field)) === value) &&
        (!q || row.key.toLowerCase().includes(q) || page.search.some((f) => text(fieldOf(row, f))?.toLowerCase().includes(q))),
    );
    matching.sort((a, b) => compare(fieldOf(a, page.sort.by), fieldOf(b, page.sort.by), page.sort.desc));

    let groups: EntityGroup[] | null = null;
    if (page.group) {
      const { by, period } = page.group;
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
    const chart = page.chart ? await this.chart(userId, page.chart.history, rows, page.title) : null;
    return { ...header, page, rows: matching.slice(query.offset, query.offset + query.limit), total: matching.length, counts, groups, chart };
  }

  /** M33 (M29-T8's, for an App): every key's values, the CHART_SERIES with the highest latest value, named by their entity. */
  private async chart(userId: string, collection: string, rows: ViewRow[], title: string): Promise<ViewChart> {
    const points = await this.prisma.client.dataPoint.findMany({ where: { userId, collection }, orderBy: { at: "asc" }, select: { key: true, at: true, value: true } });
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
    const page = viewPageOf(definition, type);
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
    const row = rowOf(entity, dataType);
    const stages = dataType.stages;
    const current = stages ? (entity.stage ?? stages.initial) : null;
    return {
      ...header,
      list: { label: list.label, title: list.title },
      page,
      row,
      history,
      stage: stages ? { value: current, moves: movesFrom(stages, current!, "me"), dates: entity.stageDates as Record<string, string> } : null,
      mine: (entity.mine ?? {}) as Record<string, unknown>,
      actions: page.actions.flatMap((action, i) => (actionApplies(action, row.value, entityValueAt) ? [i] : [])),
    };
  }

  private async header(userId: string, appId: string, type: string): Promise<{ header: AppPageHeader; definition: AppDefinition }> {
    const app = await this.prisma.client.app.findFirst({ where: { appId, userId } });
    const version = app?.currentVersionId
      ? await this.prisma.client.appVersion.findUnique({ where: { appVersionId: app.currentVersionId } })
      : null;
    if (!app || !version) throw new NotFoundException();
    const definition = readAppSource(version.source);
    if (!Object.hasOwn(definition.types, type)) throw new NotFoundException(`"${definition.name}" has no type "${type}"`);
    return { header: { appId, app: definition.name, version: version.version, type }, definition };
  }
}

/** An entity as a row: what pipelines wrote, with my fields over it, and its stage. */
function rowOf(entity: DataEntity, type: DataType): ViewRow {
  return {
    key: entity.key,
    value: entityItem(entity.value, entity.mine, type.stages ? { field: type.stages.field, value: entity.stage ?? type.stages.initial } : undefined),
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

/** A value as filters and search compare it: text, numbers and yes/no as text. */
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

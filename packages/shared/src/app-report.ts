import { z } from "zod";
import { entityValueAt, type AppDefinition, type ReportPage } from "./app";
import { actionApplies, fieldLabel, groupValue, type AppPageHeader } from "./app-pages";
import { fieldOf, type ViewIcon, type ViewRow } from "./view";

/**
 * A type's report page: counts, sums and states reached by its entities in a period, as tiles, trends over time and
 * tables by a field. Nothing in it knows what the type is: the App's `pages` say what to count.
 */

const DAY_MS = 86_400_000;
/** A table shows this many rows at most, the rest counted. */
export const REPORT_ROWS = 25;
/** A trend has at most this many points: an all-time trend by day over years stops here. */
const MAX_POINTS = 1000;

type Conditions = Record<string, string | boolean | string[]>;
/** A trend's point: a day, a week (from Monday) or a month. */
export type ReportEvery = "day" | "week" | "month";

export interface ReportMeasure {
  label: string;
  count: boolean;
  /** A number or money field summed. */
  sum: string | null;
  /** money: the field holding its currency; a sum per currency. */
  currency: string | null;
  /** States of the type's stage: the entities that reached any of them, whatever their stage is now. */
  reached: string[] | null;
  when: Conditions | null;
}

export interface ResolvedReportPage {
  type: string;
  label: string;
  icon: ViewIcon;
  date: { field: string; label: string };
  periods: number[];
  /** The type's stage field, for `reached`. */
  stage: string | null;
  tiles: (ReportMeasure & { of: string | null })[];
  trends: (ReportMeasure & { every: ReportEvery })[];
  tables: {
    label: string;
    by: string;
    /** Lower bounds, highest first; null: by the field's values. */
    bands: number[] | null;
    /** The order of the values: an enum's, yes before no; null: the most first. */
    values: string[] | null;
    columns: string[];
  }[];
}

/** The type's report as written; null: it has none. */
export function reportPageOf(app: AppDefinition, typeName: string): ResolvedReportPage | null {
  const page = app.pages.find((p): p is ReportPage => "report" in p && p.report === typeName);
  const type = app.types[typeName];
  if (!page || !type) return null;
  const measure = (m: ReportPage["tiles"][number] | ReportPage["trends"][number]): ReportMeasure => ({
    label: m.label,
    count: m.count === true,
    sum: m.sum ?? null,
    currency: (m.sum && type.fields[m.sum]?.currency) || null,
    reached: m.reached === undefined ? null : [m.reached].flat(),
    when: m.when ?? null,
  });
  return {
    type: typeName,
    label: page.menu?.label ?? `${typeName} report`,
    icon: page.menu?.icon ?? "chart",
    date: { field: page.date, label: fieldLabel(type, page.date) },
    periods: page.periods,
    stage: type.stages?.field ?? null,
    tiles: page.tiles.map((t) => ({ ...measure(t), of: t.of ?? null })),
    trends: page.trends.map((t) => ({ ...measure(t), every: t.every })),
    tables: page.tables.map((t) => {
      const field = type.fields[t.by];
      const values = field?.type === "enum" ? (field.values ?? []) : field?.type === "yesno" ? ["Yes", "No"] : null;
      return {
        label: t.label ?? `By ${fieldLabel(type, t.by).toLowerCase()}`,
        by: t.by,
        bands: t.bands ? [...t.bands].sort((a, b) => b - a) : null,
        values,
        columns: t.columns,
      };
    }),
  };
}

/** The App's reports, in the order they are written. */
export function reportPagesOf(app: AppDefinition): ResolvedReportPage[] {
  return app.pages.flatMap((p) => ("report" in p ? [reportPageOf(app, p.report)!] : []));
}

/** An entity as a report reads it: its row, and when it first reached each state. */
export interface ReportEntity {
  row: ViewRow;
  stageDates: Record<string, string>;
}

/** A value per currency ("" without one). */
export type ReportSums = Record<string, number>;

export interface ReportCell {
  sums: ReportSums;
  /** Its share of the tile it is `of`, as a whole percent; null without one (or of nothing). */
  share: number | null;
}

export interface ReportResult {
  /** The period's start; null: all time. */
  from: string | null;
  /** The entities in the period. */
  count: number;
  tiles: (ReportCell & { label: string })[];
  trends: { label: string; every: ReportEvery; series: { currency: string; points: { at: string; value: number }[] }[] }[];
  tables: {
    label: string;
    columns: string[];
    rows: { value: string | null; label: string; cells: ReportCell[] }[];
    /** Rows left out past REPORT_ROWS. */
    more: number;
  }[];
}

export interface AppReportView extends AppPageHeader, ReportResult {
  page: ResolvedReportPage;
  days: number | null;
}

export const AppReportQuerySchema = z
  .object({
    /** The period in days, or "all"; left out: the page's first period. */
    days: z.union([z.literal("all"), z.coerce.number().int().min(1).max(3650)]).optional(),
  })
  .strict();
export type AppReportQuery = z.output<typeof AppReportQuerySchema>;

/** The report of the entities whose date is in the last `days` (null: all of them). */
export function reportOf(page: ResolvedReportPage, entities: ReportEntity[], days: number | null, now = new Date()): ReportResult {
  const from = days === null ? null : now.getTime() - days * DAY_MS;
  const dated = entities.map((entity) => ({ entity, at: dateOf(fieldOf(entity.row, page.date.field)) }));
  const inPeriod = from === null ? dated : dated.filter((d) => d.at !== null && d.at >= from);
  const all = inPeriod.map((d) => d.entity);
  const tile = (label: string) => page.tiles.find((t) => t.label === label)!;
  const cell = (t: ResolvedReportPage["tiles"][number], of: ReportEntity[]): ReportCell => {
    const sums = measureOf(page, t, of);
    return { sums, share: t.of ? share(sums, measureOf(page, tile(t.of), of)) : null };
  };

  return {
    from: from === null ? null : new Date(from).toISOString(),
    count: all.length,
    tiles: page.tiles.map((t) => ({ label: t.label, ...cell(t, all) })),
    trends: page.trends.map((trend) => {
      const points = inPeriod.filter((d): d is { entity: ReportEntity; at: number } => d.at !== null);
      if (points.length === 0) return { label: trend.label, every: trend.every, series: [] };
      const start = bucketOf(from ?? Math.min(...points.map((p) => p.at)), trend.every);
      const end = Math.max(now.getTime(), ...points.map((p) => p.at));
      const buckets: number[] = [];
      for (let at = start; at <= end && buckets.length < MAX_POINTS; at = nextBucket(at, trend.every)) buckets.push(at);
      const byBucket = new Map<number, ReportEntity[]>();
      for (const p of points) {
        const bucket = bucketOf(p.at, trend.every);
        byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), p.entity]);
      }
      const sums = buckets.map((at) => ({ at, sums: measureOf(page, trend, byBucket.get(at) ?? []) }));
      const currencies = [...new Set(sums.flatMap((s) => Object.keys(s.sums)))].sort();
      return {
        label: trend.label,
        every: trend.every,
        series: currencies.map((currency) => ({
          currency,
          points: sums.map((s) => ({ at: new Date(s.at).toISOString(), value: s.sums[currency] ?? 0 })),
        })),
      };
    }),
    tables: page.tables.map((table) => {
      const valueOf = (entity: ReportEntity): string | null => {
        const value = fieldOf(entity.row, table.by);
        if (table.bands) return typeof value === "number" ? bandOf(value, table.bands) : null;
        return groupValue(entity.row.titles?.[table.by] ?? value, null);
      };
      const groups = new Map<string | null, ReportEntity[]>();
      for (const entity of all) {
        const value = valueOf(entity);
        groups.set(value, [...(groups.get(value) ?? []), entity]);
      }
      const rows = [...groups].map(([value, of]) => ({
        value,
        label: value ?? "—",
        cells: table.columns.map((column) => cell(tile(column), of)),
      }));
      const order = table.bands ? bandLabels(table.bands) : table.values;
      const total = (row: (typeof rows)[number]) => Object.values(row.cells[0]?.sums ?? {}).reduce((a, b) => a + b, 0);
      rows.sort((a, b) => {
        if (a.value === null || b.value === null) return a.value === b.value ? 0 : a.value === null ? 1 : -1;
        if (order) return rank(order, a.value) - rank(order, b.value);
        return total(b) - total(a) || a.label.localeCompare(b.label, "en", { numeric: true });
      });
      return { label: table.label, columns: table.columns, rows: rows.slice(0, REPORT_ROWS), more: Math.max(0, rows.length - REPORT_ROWS) };
    }),
  };
}

/** What a measure counts among these entities: per currency for money, else under "". */
function measureOf(page: ResolvedReportPage, measure: ReportMeasure, entities: ReportEntity[]): ReportSums {
  const counted = entities.filter(
    (e) =>
      (measure.reached === null || measure.reached.some((state) => reached(page, e, state))) &&
      (measure.when === null || actionApplies({ when: measure.when }, e.row.value, entityValueAt)),
  );
  if (measure.sum === null) return { "": counted.length };
  const sums: ReportSums = {};
  for (const e of counted) {
    const amount = fieldOf(e.row, measure.sum);
    if (typeof amount !== "number") continue;
    const currencyValue = measure.currency ? fieldOf(e.row, measure.currency) : "";
    const currency = typeof currencyValue === "string" ? currencyValue : "";
    sums[currency] = Math.round(((sums[currency] ?? 0) + amount) * 100) / 100;
  }
  return sums;
}

/** Reached a state: it was there once (its date is kept), or is there now. */
function reached(page: ResolvedReportPage, entity: ReportEntity, state: string): boolean {
  return entity.stageDates[state] !== undefined || (page.stage !== null && fieldOf(entity.row, page.stage) === state);
}

function share(part: ReportSums, whole: ReportSums): number | null {
  const of = whole[""];
  return of ? Math.round(((part[""] ?? 0) / of) * 100) : null;
}

/** A date or a time as milliseconds; null: not one. */
function dateOf(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

/** The start of the day, week (Monday) or month an instant is in, in UTC. */
function bucketOf(at: number, every: ReportEvery): number {
  const date = new Date(at);
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (every === "day") return day;
  if (every === "week") return day - ((date.getUTCDay() + 6) % 7) * DAY_MS;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function nextBucket(at: number, every: ReportEvery): number {
  if (every === "day") return at + DAY_MS;
  if (every === "week") return at + 7 * DAY_MS;
  const date = new Date(at);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

/** Bands from their lower bounds, highest first: "80+", "60–80", …, "below 0". */
function bandLabels(bands: number[]): string[] {
  return [...bands.map((low, i) => (i === 0 ? `${low}+` : `${low}–${bands[i - 1]}`)), `below ${bands.at(-1)}`];
}

function bandOf(value: number, bands: number[]): string {
  const labels = bandLabels(bands);
  const i = bands.findIndex((low) => value >= low);
  return i < 0 ? labels.at(-1)! : labels[i];
}

function rank(order: string[], value: string): number {
  const i = order.indexOf(value);
  return i < 0 ? order.length : i;
}

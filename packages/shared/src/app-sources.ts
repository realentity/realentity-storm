import { caselessFields, type DataType, type FieldKind, type PageSource } from "./app";
import { matchesAll } from "./conditions";
import { fieldOf, type ViewRow } from "./view";

/**
 * M65: a page's sources (DataSource) and its filters by type, as the api evaluates them over an App's own entities:
 * the distinct values of a field with their counts, or entities as items; equals, contains, a day or a range.
 */

/** One distinct value of a field: as a filter takes it, as it is shown, and how many entities have it. */
export interface SourceValue {
  value: string;
  label: string;
  count: number;
}

export type SourceView =
  | { kind: "values"; field: string; values: SourceValue[] }
  | { kind: "items"; items: { id: string; label: string }[] };

/** A filter's value: one, or several (any of them). A date's: a day (2026-11-25) or a range (2026-11-01..2026-11-30). */
export type FilterValue = string | string[];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A day, or a range with one or both ends: "2026-11-01..2026-11-30", "..2026-11-30", "2026-11-01..". */
export function isDayFilter(value: string): boolean {
  if (DAY.test(value)) return true;
  const ends = value.split("..");
  return ends.length === 2 && ends.some((end) => end !== "") && ends.every((end) => end === "" || DAY.test(end));
}

/** A field's kind; @firstSeen and @lastSeen are times. */
export function kindOfField(type: Pick<DataType, "fields">, field: string): FieldKind | undefined {
  return field.startsWith("@") ? "datetime" : type.fields[field]?.type;
}

const DAY_FORMATS = new Map<string, Intl.DateTimeFormat>();

/** A date's day as it is; a time's, in `zone` (the instance's TZ): an entity added at 23:30 in Sofia is on that day. */
export function dayOf(value: unknown, kind: FieldKind | undefined, zone: string): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  if (kind === "date") return value.slice(0, 10);
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  let format = DAY_FORMATS.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    DAY_FORMATS.set(zone, format);
  }
  return format.format(at);
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** A row's values of a field, as a filter and a source see them: a list's each, a date's day (`by: day`), else one. */
function valuesOf(row: ViewRow, field: string, kind: FieldKind | undefined, byDay: boolean, zone: string): string[] {
  const value = fieldOf(row, field);
  if (Array.isArray(value)) return value.map(text).filter((v): v is string => v !== null && v !== "");
  if (byDay) {
    const day = dayOf(value, kind, zone);
    return day ? [day] : [];
  }
  const one = text(value);
  return one === null || one === "" ? [] : [one];
}

/**
 * The distinct values of a field over the rows, with how many rows have each: a list's values each (without case
 * unless it is caseSensitive: the first spelling shown), a date's days with `by: day`. In order: days and dates oldest
 * first, an enum's as written, yes before no, the rest most used first.
 */
export function distinctValues(type: DataType, field: string, byDay: boolean, rows: readonly ViewRow[], zone: string): SourceValue[] {
  const kind = kindOfField(type, field);
  const caseless = caselessFields(type).has(field);
  const counts = new Map<string, SourceValue>();
  for (const row of rows) {
    const seen = new Set<string>();
    for (const value of valuesOf(row, field, kind, byDay, zone)) {
      const id = caseless ? value.toLowerCase() : value;
      if (seen.has(id)) continue;
      seen.add(id);
      const known = counts.get(id);
      if (known) known.count += 1;
      else counts.set(id, { value, label: labelOf(type, field, kind, value, row), count: 1 });
    }
  }
  return [...counts.values()].sort(orderOf(type, field, kind, byDay));
}

function labelOf(type: DataType, field: string, kind: FieldKind | undefined, value: string, row: ViewRow): string {
  if (kind === "yesno") return value === "true" ? "Yes" : "No";
  // A ref by its entity's title, when the row's is known.
  if (kind === "ref") return row.titles?.[field] ?? value;
  return value;
}

function orderOf(type: DataType, field: string, kind: FieldKind | undefined, byDay: boolean): (a: SourceValue, b: SourceValue) => number {
  if (byDay || kind === "date" || kind === "datetime") return (a, b) => a.value.localeCompare(b.value);
  if (kind === "enum") {
    const values = type.fields[field]?.values ?? [];
    return (a, b) => values.indexOf(a.value) - values.indexOf(b.value);
  }
  if (kind === "yesno") return (a, b) => (a.value === "true" ? -1 : 0) - (b.value === "true" ? -1 : 0);
  return (a, b) => b.count - a.count || a.label.localeCompare(b.label, "en", { numeric: true });
}

/** A source of items: the rows that match its `where`, in its order, each by its id and label. */
export function sourceItems(
  type: DataType,
  source: Extract<PageSource, { where?: unknown }>,
  rows: readonly ViewRow[],
  naming: { title: string },
): { id: string; label: string }[] {
  const caseless = caselessFields(type);
  const asItem = (row: ViewRow) => ({ ...row.value, "@firstSeen": row.firstSeenAt, "@lastSeen": row.lastSeenAt });
  const matching = source.where ? rows.filter((row) => matchesAll(asItem(row), source.where!, { caseless })) : [...rows];
  if (source.sort) {
    const by = source.sort.replace(/^-/, "");
    const desc = source.sort.startsWith("-");
    matching.sort((a, b) => ordered(fieldOf(a, by), fieldOf(b, by)) * (desc ? -1 : 1));
  }
  return matching.slice(0, source.limit).map((row) => {
    const id = source.id ? (text(fieldOf(row, source.id)) ?? row.key) : row.key;
    const display = source.display ?? naming.title;
    return { id, label: row.titles?.[display] ?? text(fieldOf(row, display)) ?? id };
  });
}

function ordered(a: unknown, b: unknown): number {
  if (a === undefined || a === null) return b === undefined || b === null ? 0 : 1;
  if (b === undefined || b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return (text(a) ?? JSON.stringify(a)).localeCompare(text(b) ?? JSON.stringify(b), "en", { numeric: true });
}

/** A filter's values as a list; none: no filter. */
export function filterValues(value: FilterValue | undefined): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).filter((v) => v !== "");
}

/** How a field is filtered: a list contains one of the values, a date is on one of the days or in a range, else equals. */
export function filterMatch(kind: FieldKind | undefined): "contains" | "day" | "equals" {
  if (kind === "list") return "contains";
  if (kind === "date" || kind === "datetime") return "day";
  return "equals";
}

/** Does a row pass a filter on a field: any of the wanted values (a list's without case unless caseSensitive)? */
export function filterMatches(type: DataType, field: string, row: ViewRow, wanted: readonly string[], zone: string): boolean {
  if (wanted.length === 0) return true;
  const kind = kindOfField(type, field);
  switch (filterMatch(kind)) {
    case "contains": {
      const caseless = caselessFields(type).has(field);
      const fold = (v: string) => (caseless ? v.toLowerCase() : v);
      const values = new Set(valuesOf(row, field, kind, false, zone).map(fold));
      return wanted.some((w) => values.has(fold(w)));
    }
    case "day": {
      const day = dayOf(fieldOf(row, field), kind, zone);
      return day !== null && wanted.some((w) => inDays(day, w));
    }
    case "equals":
      return wanted.includes(text(fieldOf(row, field)) ?? "");
  }
}

/** A day against a filter's day or range (both ends included). */
function inDays(day: string, wanted: string): boolean {
  if (DAY.test(wanted)) return day === wanted;
  const [from, to] = wanted.split("..");
  return (!from || day >= from) && (!to || day <= to);
}

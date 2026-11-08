import { z } from "zod";
import { isMineField, movesFrom, type AppDefinition, type DataType, type EntityActionDef, type FieldKind, type FormPage, type ListPage, type ViewPage } from "./app";
import { type ViewChart, type ViewFormat, type ViewIcon, type ViewRow } from "./view";

/**
 * An App's pages (M31) as the web app draws them: every type has a list and a view, as its App's `pages` say or by
 * default from its fields. A field's format comes from its kind.
 */

const FORMAT: Record<FieldKind, ViewFormat> = {
  text: "text",
  longtext: "text",
  number: "number",
  money: "money",
  date: "date",
  datetime: "datetime",
  url: "link",
  email: "text",
  yesno: "yesno",
  enum: "badge",
  list: "text",
};

export interface PageColumn {
  field: string;
  label: string;
  as: ViewFormat;
  /** money: the field holding its currency. */
  currency?: string;
  /** A date shown with a badge when it is near (M33). */
  due?: { days: number; unless?: Record<string, string | boolean | string[]> };
}

/** A group's total (M33: only of the entities as `when` says). */
export interface PageTotal extends PageColumn {
  when?: Record<string, string | boolean | string[]>;
}

export interface PageFilter {
  field: string;
  label: string;
  /** The values to pick from: an enum's, or yes and no. */
  values: { value: string; label: string }[];
}

/** A field on a form (M32): its input from its kind. */
export interface FormField {
  field: string;
  label: string;
  kind: FieldKind;
  values?: string[];
  required: boolean;
}

/** A type's stage (M32), for its pages. */
export interface PageStages {
  field: string;
  label: string;
  states: string[];
}

export interface ResolvedListPage {
  type: string;
  /** A type of mine (M32): the user adds entities from the list, on a form of all its fields. */
  mine: boolean;
  create: FormField[] | null;
  actions: { label: string; run: string; confirm?: string }[];
  label: string;
  icon: ViewIcon;
  menu: boolean;
  /** The field that names an entity, and the one that is its address (the first url field). */
  title: string;
  link: string | null;
  columns: PageColumn[];
  filters: PageFilter[];
  search: string[];
  sort: { by: string; desc: boolean };
  group: { by: PageColumn; period: "month" | "year" | null; totals: PageTotal[] } | null;
  removed: boolean;
  /** Each row's stage moves of mine (M33): from a state, where to. */
  moves: { field: string; to: Record<string, string[]> } | null;
  chart: { history: string; label: string; stepped: boolean } | null;
}

export interface ResolvedViewPage {
  type: string;
  mine: boolean;
  stages: PageStages | null;
  /** Fields of mine on its form; empty: none to edit. */
  form: FormField[];
  actions: EntityActionDef[];
  title: string;
  link: string | null;
  sections: { title: string | null; fields: PageColumn[] }[];
  history: { collection: string; label: string; stepped: boolean } | null;
}

/** "salaryCurrency" → "Salary currency"; @firstSeen → "First seen". */
export function fieldLabel(type: DataType, field: string): string {
  if (field === "@firstSeen") return "First seen";
  if (field === "@lastSeen") return "Last seen";
  const label = type.fields[field]?.label;
  if (label) return label;
  const last = field.split(".").at(-1)!;
  const words = last
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function column(type: DataType, field: string, label?: string): PageColumn {
  const kind = field.startsWith("@") ? "datetime" : (type.fields[field]?.type ?? "text");
  const currency = type.fields[field]?.currency;
  return {
    field,
    label: label ?? fieldLabel(type, field),
    as: field.startsWith("@") ? "date" : FORMAT[kind],
    ...(currency ? { currency } : {}),
  };
}

/** A type's name and address fields: its title (else its key), and its first url field. */
function naming(type: DataType): { title: string; link: string | null } {
  return { title: type.title ?? type.key, link: Object.entries(type.fields).find(([, f]) => f.type === "url")?.[0] ?? null };
}

/**
 * The type's list: as written, or by default its title, then its required fields, then the others that fit a row
 * (not long text, lists or currency codes), six at most; enum and yes/no fields as filters; text fields searched;
 * newest first.
 */
export function listPageOf(app: AppDefinition, typeName: string): ResolvedListPage {
  const type = app.types[typeName];
  const page = app.pages.find((p): p is ListPage => "list" in p && p.list === typeName);
  const { title, link } = naming(type);
  const entries = Object.entries(type.fields);
  const currencies = new Set(entries.flatMap(([, f]) => (f.currency ? [f.currency] : [])));
  const fits = ([name, f]: [string, (typeof entries)[number][1]]) =>
    f.type !== "longtext" && f.type !== "list" && !currencies.has(name) && f.type !== "url";
  const defaultColumns = [
    ...new Set([title, ...entries.filter(([, f]) => f.required).map(([n]) => n), ...entries.filter(fits).map(([n]) => n)]),
  ]
    .filter((name) => name === title || fits([name, type.fields[name]]))
    .slice(0, 6);
  const columns = page?.columns
    ? page.columns.map((c) => (typeof c === "string" ? column(type, c) : { ...column(type, c.field, c.label), ...(c.due ? { due: c.due } : {}) }))
    : defaultColumns.map((name) => column(type, name));
  const filterFields =
    page?.filters ??
    entries
      .filter(([, f]) => f.type === "enum" || f.type === "yesno")
      .map(([n]) => n)
      .slice(0, 4);
  const sort = page?.sort ?? "-@firstSeen";
  const menu = page?.menu;
  return {
    type: typeName,
    mine: type.mine,
    create: type.mine ? formFields(type, Object.keys(type.fields)) : null,
    actions: page?.actions ?? [],
    label: (menu && menu.label) || typeName,
    icon: (menu && menu.icon) || app.icon,
    menu: menu !== false,
    title,
    link,
    columns,
    filters: filterFields.map((field) => ({
      field,
      label: fieldLabel(type, field),
      values:
        type.fields[field]?.type === "enum"
          ? (type.fields[field].values ?? []).map((value) => ({ value, label: value }))
          : [
              { value: "true", label: "Yes" },
              { value: "false", label: "No" },
            ],
    })),
    search: page?.search ?? entries.filter(([, f]) => f.type === "text" || f.type === "longtext" || f.type === "enum").map(([n]) => n),
    sort: { by: sort.replace(/^-/, ""), desc: sort.startsWith("-") },
    group: page?.group
      ? {
          by: column(type, page.group.by),
          period: page.group.period ?? null,
          totals: page.group.totals.map((t): PageTotal => (typeof t === "string" ? column(type, t) : { ...column(type, t.field, t.label), ...(t.when ? { when: t.when } : {}) })),
        }
      : null,
    removed: page?.removed ?? false,
    chart: page?.chart ? { history: page.chart.history, label: page.chart.label ?? "Over time", stepped: page.chart.stepped } : null,
    moves:
      page?.moves && type.stages
        ? { field: type.stages.field, to: Object.fromEntries(type.stages.states.map((from) => [from, movesFrom(type.stages!, from, "me")])) }
        : null,
  };
}

/** The type's own page: as written, or every field in the order they are written. */
export function viewPageOf(app: AppDefinition, typeName: string): ResolvedViewPage {
  const type = app.types[typeName];
  const page = app.pages.find((p): p is ViewPage => "view" in p && p.view === typeName);
  const sections = page?.sections
    ? page.sections.map((s) => ({ title: s.title, fields: s.fields.map((f) => column(type, f)) }))
    : [{ title: null, fields: (page?.fields ?? Object.keys(type.fields)).map((f) => column(type, f)) }];
  const form = app.pages.find((p): p is FormPage => "form" in p && p.form === typeName);
  return {
    type: typeName,
    mine: type.mine,
    stages: type.stages ? { field: type.stages.field, label: fieldLabel(type, type.stages.field), states: type.stages.states } : null,
    // A type of mine: every field but its key, which names the entity and stays.
    form: formFields(type, form?.fields ?? Object.keys(type.fields).filter((name) => isMineField(type, name) && !(type.mine && name === type.key))),
    actions: page?.actions ?? [],
    ...naming(type),
    sections,
    history: page?.history
      ? { collection: page.history.collection, label: page.history.label ?? "History", stepped: page.history.stepped }
      : null,
  };
}

function formFields(type: DataType, names: string[]): FormField[] {
  return names
    .filter((name) => type.stages?.field !== name)
    .map((name) => {
      const field = type.fields[name];
      return { field: name, label: fieldLabel(type, name), kind: field.type, required: field.required, ...(field.values ? { values: field.values } : {}) };
    });
}

/** Does an entity have the values a `when` asks for (a button's, a total's, a due date's `unless`)? */
export function actionApplies(
  action: { when?: Record<string, string | boolean | string[]> },
  item: Record<string, unknown>,
  valueAt: (item: Record<string, unknown>, path: string) => unknown,
): boolean {
  return Object.entries(action.when ?? {}).every(([field, wanted]) => {
    const value = valueAt(item, field);
    return Array.isArray(wanted) ? wanted.includes(String(value)) : value === wanted || String(value) === String(wanted);
  });
}

// --- the api (M31) ---

/** An App's list page in the menu. */
export interface AppMenuItem {
  appId: string;
  appName: string;
  type: string;
  label: string;
  icon: ViewIcon;
}

export const AppListQuerySchema = z
  .object({
    tab: z.enum(["current", "removed"]).default("current"),
    q: z.string().trim().max(200).optional(),
    /** Filters as JSON: { "status": "applied", "favorite": "true" }. */
    filter: z
      .string()
      .max(2000)
      .optional()
      .transform((text, ctx) => {
        if (!text) return {};
        try {
          const parsed = z.record(z.string(), z.string().max(200)).parse(JSON.parse(text));
          return parsed;
        } catch {
          ctx.addIssue({ code: "custom", message: 'filters as JSON, e.g. {"status":"applied"}' });
          return z.NEVER;
        }
      }),
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
/** As the web app sends it: offset and limit as numbers (the schema reads them from the query string). */
export type AppListQuery = Omit<z.input<typeof AppListQuerySchema>, "offset" | "limit"> & { offset?: number; limit?: number };
export type AppListQueryParsed = z.output<typeof AppListQuerySchema>;

export interface AppPageHeader {
  appId: string;
  app: string;
  version: number;
  type: string;
}

export interface EntityGroup {
  /** The group's value as text ("applied", "2026-11", "Yes"); null: without one. */
  value: string | null;
  label: string;
  count: number;
  /** Per total, in the page's order: its sum per currency ("" without one). */
  totals: { field: string; sums: Record<string, number> }[];
}

export interface AppListView extends AppPageHeader {
  page: ResolvedListPage;
  /** Entities as rows (fields of mine over what pipelines wrote), in groups when the page has them, then paged. */
  rows: ViewRow[];
  total: number;
  counts: { current: number; removed: number };
  /** Every group of the matching rows (not only this page's). */
  groups: EntityGroup[] | null;
  /** The list's chart (M33): a series per key, the highest latest values; null without `chart`. */
  chart: ViewChart | null;
}

export interface AppEntityView extends AppPageHeader {
  list: { label: string; title: string };
  page: ResolvedViewPage;
  row: ViewRow;
  history: { at: string; value: number }[] | null;
  /** M32: its stage, where the user may move it, and when it first reached each state. */
  stage: { value: string | null; moves: string[]; dates: Record<string, string> } | null;
  /** Fields of mine as the user set them (the form's values). */
  mine: Record<string, unknown>;
  /** The indexes of the view's buttons that apply to it now (`when`). */
  actions: number[];
}

/** M32: fields of mine on an entity's form; null or "" clears one. A type of mine: any field, the key too on creation. */
export const EntityValuesRequestSchema = z.object({ values: z.record(z.string(), z.unknown()) }).strict();
export type EntityValuesRequest = z.infer<typeof EntityValuesRequestSchema>;

export const MoveStageRequestSchema = z.object({ to: z.string().trim().min(1).max(40) }).strict();
export type MoveStageRequest = z.infer<typeof MoveStageRequestSchema>;

export const PageActionRequestSchema = z.object({ key: z.string().min(1).max(2000).optional() }).strict();
export type PageActionRequest = z.infer<typeof PageActionRequestSchema>;

/** The group an entity is in: its value as text, a date's month or year. */
export function groupValue(value: unknown, period: "month" | "year" | null): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const text = typeof value === "string" ? value : typeof value === "number" ? String(value) : JSON.stringify(value);
  if (period === "month") return /^\d{4}-\d{2}/.test(text) ? text.slice(0, 7) : null;
  if (period === "year") return /^\d{4}/.test(text) ? text.slice(0, 4) : null;
  return text;
}

import { z } from "zod";
import {
  addedByHand,
  addFieldNames,
  caselessFields,
  formFieldNames,
  isRefField,
  isTextList,
  movesFrom,
  type AppDefinition,
  type DataType,
  type EntityActionDef,
  type FieldKind,
  type FilterControl,
  type FormPage,
  filterControlsOf,
  type ListPage,
  type PageControl,
  type PageSource,
  type ViewPage,
} from "./app";
import { filterMatch, kindOfField, type FilterValue, type SourceView } from "./app-sources";
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
  file: "file",
  image: "image",
  ref: "text",
  credential: "text",
};

export interface PageColumn {
  field: string;
  label: string;
  as: ViewFormat;
  /** money: the field holding its currency. */
  currency?: string;
  /** M65: a list's or an enum's values as chips (default: as text). */
  control?: "chips";
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
  /** The values to pick from: an enum's, or yes and no; M55: a ref's, the entities of its type (the api fills them). */
  values: { value: string; label: string }[];
  /** M55: a ref's: the type its values are entities of. */
  ref?: string;
  /** M65: how it matches: equals (enum, yes/no, ref), contains (a list's values), on a day or in a range (a date). */
  match: "equals" | "contains" | "day";
  /** M65: how it is picked: a dropdown (a date's: a date input) by default, or as the page's `controls` say. */
  control: FilterControl;
  /** M65: several values picked, any of them matching. */
  multiple: boolean;
  /** M65: the page's source its choices (a calendar's marked days) come from; null: its own `values`. */
  source: string | null;
  /** M65: a list of text that isn't caseSensitive: "Home" is "home" (the spelling shown is the first seen). */
  caseless: boolean;
}

/** A field on a form (M32): its input from its kind. */
export interface FormField {
  field: string;
  label: string;
  kind: FieldKind;
  values?: string[];
  required: boolean;
  /** M52: an encrypted field: the form never shows its value, only that one is set, and sends one only when typed. */
  encrypted?: boolean;
  /** M55: a ref (M56: or a list of refs): the type whose entities it is picked from. */
  ref?: string;
  /** M66: `ref` is a use, another App's type: its choices are the chosen App's (GET /apps/:appId/uses/:name/choices). */
  use?: true;
  /** M57: a credential: the host it is for, its choices the credentials allowed there. */
  for?: string;
  /** M56: picked among the ones whose field of this name is the form's (an Entry's path, of its project). */
  match?: string;
  /** M56: on the form only while its other fields have these values; required only then. */
  when?: Record<string, string | boolean | string[]>;
  /** M55: a line under its input. */
  help?: string;
}

/** M55: the entities pointing at an entity, on its page: by their ref field `by`. */
export interface PageRelated {
  type: string;
  by: string;
  label: string;
  columns: PageColumn[];
  filters: PageFilter[];
  title: string;
  /** The form that adds one there (its `by` set to this entity); null: not added there. */
  create: FormField[] | null;
  /** M56: its Add buttons, each with the fields it sets on that form (an Add of `add: true` sets none). */
  adds: { label: string; set: Record<string, string> }[];
  /**
   * M56: rows in groups by this field: an enum's values, or a ref's entities (of `ref`; the ones whose `match` is the
   * page's entity when it is `by`), each group with its Add.
   */
  group: { field: string; label: string; values: string[] | null; ref: string | null; match: string | null } | null;
}

/** A type's stage (M32), for its pages. */
export interface PageStages {
  field: string;
  label: string;
  states: string[];
}

export interface ResolvedListPage {
  type: string;
  /** A type of mine (M32): pipelines never write it. */
  mine: boolean;
  /** The form that adds one by hand (M32: a type of mine's; M45: a list with `add`); null: added only by pipelines. */
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
  /** M65: the page's sources, as written; the list view carries what they return. */
  sources: Record<string, PageSource>;
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
  /** M45: deleted by hand (a type of mine, or one added by hand). */
  remove: boolean;
  stages: PageStages | null;
  /** The fields on its form (M45: any but the key and the stage); empty: none to edit. */
  form: FormField[];
  actions: EntityActionDef[];
  title: string;
  link: string | null;
  sections: { title: string | null; fields: PageColumn[] }[];
  history: { collection: string; label: string; stepped: boolean } | null;
  related: PageRelated[];
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
 * (not long text, lists or currency codes), six at most; enum and yes/no fields as filters; text fields (M65: and
 * lists of text) searched;
 * newest first.
 */
export function listPageOf(app: AppDefinition, typeName: string): ResolvedListPage {
  const type = app.types[typeName];
  const page = app.pages.find((p): p is ListPage => "list" in p && p.list === typeName);
  const { title, link } = naming(type);
  const entries = Object.entries(type.fields);
  const currencies = new Set(entries.flatMap(([, f]) => (f.currency ? [f.currency] : [])));
  const fits = ([name, f]: [string, (typeof entries)[number][1]]) =>
    f.type !== "longtext" && f.type !== "list" && !currencies.has(name) && f.type !== "url" && !f.encrypted;
  const defaultColumns = [
    ...new Set([title, ...entries.filter(([, f]) => f.required).map(([n]) => n), ...entries.filter(fits).map(([n]) => n)]),
  ]
    .filter((name) => name === title || fits([name, type.fields[name]]))
    .slice(0, 6);
  const columns = page?.columns
    ? page.columns.map((c) =>
        typeof c === "string"
          ? column(type, c)
          : { ...column(type, c.field, c.label), ...(c.due ? { due: c.due } : {}), ...(c.control === "chips" ? { control: "chips" as const } : {}) },
      )
    : defaultColumns.map((name) => column(type, name));
  const controls = page?.controls ?? [];
  // M65: a field drawn by a control isn't a default filter as well.
  const filterFields =
    page?.filters ??
    entries
      .filter(([name, f]) => (f.type === "enum" || f.type === "yesno") && !controls.some((c) => c.filters === name))
      .map(([n]) => n)
      .slice(0, 4);
  const sort = page?.sort ?? "-@firstSeen";
  const menu = page?.menu;
  return {
    type: typeName,
    mine: type.mine,
    create: addedByHand(app, typeName) ? formFields(app, type, addFieldNames(type, app.pages.find((p): p is FormPage => "form" in p && p.form === typeName))) : null,
    actions: page?.actions ?? [],
    label: (menu && menu.label) || typeName,
    icon: (menu && menu.icon) || app.icon,
    menu: menu !== false,
    title,
    link,
    columns,
    filters: [...filterFields.map((field) => pageFilter(type, field)), ...controls.map((c) => pageFilter(type, c.filters, c))],
    sources: page?.sources ?? {},
    search:
      page?.search ??
      entries.filter(([, f]) => (f.type === "text" || f.type === "longtext" || f.type === "enum" || isTextList(f)) && !f.encrypted).map(([n]) => n),
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

/**
 * A filter's values: an enum's, yes and no; M55: a ref's are its type's entities, filled in by the api; M65: a list's
 * are the values in use (the api), a date has none (a day or a range is picked).
 */
function pageFilter(type: DataType, field: string, control?: PageControl): PageFilter {
  const f = type.fields[field];
  const kind = kindOfField(type, field);
  const match = filterMatch(kind);
  const drawn = { control: control?.control ?? filterControlsOf(kind)[0], multiple: control?.multiple ?? false, source: control?.source ?? null, caseless: caselessFields(type).has(field) };
  let values: { value: string; label: string }[] = [];
  if (f?.type === "enum") values = (f.values ?? []).map((value) => ({ value, label: value }));
  else if (kind === "yesno")
    values = [
      { value: "true", label: "Yes" },
      { value: "false", label: "No" },
    ];
  return { field, label: control?.label ?? fieldLabel(type, field), values, match, ...drawn, ...(f?.type === "ref" && f.to ? { ref: f.to } : {}) };
}

/** M55: what points at the type's entities, as its view page lists them. */
function relatedOf(app: AppDefinition, page: ViewPage | undefined): PageRelated[] {
  return (page?.related ?? []).map((related) => {
    const type = app.types[related.type];
    const list = listPageOf(app, related.type);
    const form = app.pages.find((p): p is FormPage => "form" in p && p.form === related.type);
    return {
      type: related.type,
      by: related.by,
      label: related.label ?? list.label,
      columns: related.columns ? related.columns.map((c) => column(type, c)) : list.columns.filter((c) => c.field !== related.by),
      filters: (related.filters ?? []).map((f) => pageFilter(type, f)),
      title: list.title,
      create: related.add ? formFields(app, type, addFieldNames(type, form)) : null,
      adds: Array.isArray(related.add)
        ? related.add.map((a) => ({ label: a.label, set: Object.fromEntries(Object.entries(a.set).map(([k, v]) => [k, String(v)])) }))
        : related.add
          ? [{ label: "Add", set: {} }]
          : [],
      group: related.group ? relatedGroup(type, related.group, related.by) : null,
    };
  });
}

/** M56: a related list's groups: an enum's values, or a ref's entities, the page's own when it matches by `by`. */
function relatedGroup(type: DataType, field: string, by: string): PageRelated["group"] {
  const f = type.fields[field];
  return {
    field,
    label: fieldLabel(type, field),
    values: f?.type === "enum" ? (f.values ?? []) : null,
    ref: f?.type === "ref" ? (f.to ?? null) : null,
    match: f?.type === "ref" && f.match === by ? by : null,
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
    remove: addedByHand(app, typeName),
    stages: type.stages ? { field: type.stages.field, label: fieldLabel(type, type.stages.field), states: type.stages.states } : null,
    form: formFields(app, type, formFieldNames(type, form)),
    actions: page?.actions ?? [],
    ...naming(type),
    sections,
    history: page?.history
      ? { collection: page.history.collection, label: page.history.label ?? "History", stepped: page.history.stepped }
      : null,
    related: relatedOf(app, page),
  };
}

function formFields(app: AppDefinition, type: DataType, names: string[]): FormField[] {
  const uses = app.uses ?? {};
  return names
    .filter((name) => type.stages?.field !== name)
    .map((name) => {
      const field = type.fields[name];
      return {
        field: name,
        label: fieldLabel(type, name),
        kind: field.type,
        required: field.required,
        ...(field.values ? { values: field.values } : {}),
        ...(field.encrypted ? { encrypted: true } : {}),
        ...(isRefField(field) && field.to ? { ref: field.to } : {}),
        ...(isRefField(field) && field.to && Object.hasOwn(uses, field.to) ? { use: true as const } : {}),
        ...(field.match ? { match: field.match } : {}),
        ...(field.for ? { for: field.for } : {}),
        ...(field.when ? { when: field.when } : {}),
        ...(field.help ? { help: field.help } : {}),
      };
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

/** One of an App's list or report pages: a tab in its header. */
export interface AppMenuPage {
  kind: "list" | "report";
  type: string;
  label: string;
  icon: ViewIcon;
}

/** An installed App on the launcher: its tile, and its pages as tabs once it is open. */
export interface AppMenuItem {
  appId: string;
  name: string;
  icon: ViewIcon;
  description: string | null;
  /** Its lists in the menu (those hidden from it left out), then its reports; maybe none. */
  pages: AppMenuPage[];
  /** None of the App's pipelines that run on their own is on: the tile marks it. */
  nothingOn: boolean;
  /** Proposals of its pipelines waiting for the user's decision. */
  pending: number;
  /** Pinned to the sidebar by the user. */
  pinned: boolean;
}

export const PinAppRequestSchema = z.object({ pinned: z.boolean() }).strict();
export type PinAppRequest = z.infer<typeof PinAppRequestSchema>;

export const AppListQuerySchema = z
  .object({
    tab: z.enum(["current", "removed"]).default("current"),
    q: z.string().trim().max(200).optional(),
    /**
     * Filters as JSON: { "status": "applied", "favorite": "true" }; M65: several values, any of them ({ "tags": ["home",
     * "work"] }); a date's day or range ({ "due": "2026-11-01..2026-11-30" }).
     */
    filter: z
      .string()
      .max(4000)
      .optional()
      .transform((text, ctx): Record<string, FilterValue> => {
        if (!text) return {};
        try {
          const parsed = z.record(z.string(), z.union([z.string().max(200), z.array(z.string().max(200)).max(20)])).parse(JSON.parse(text));
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
  /** M65: what the page's sources return, by name. */
  sources: Record<string, SourceView>;
}

export interface AppEntityView extends AppPageHeader {
  list: { label: string; title: string };
  page: ResolvedViewPage;
  row: ViewRow;
  history: { at: string; value: number }[] | null;
  /** M32: its stage, where the user may move it, and when it first reached each state. */
  stage: { value: string | null; moves: string[]; dates: Record<string, string> } | null;
  /** Fields as the user set them on the form; they stay over what pipelines write. */
  mine: Record<string, unknown>;
  /** M45: for a form field the user set that pipelines write too, what the pipelines wrote (Reset brings it back). */
  written: Record<string, unknown>;
  /** The indexes of the view's buttons that apply to it now (`when`). */
  actions: number[];
  /** M55: what points at it, per type: deleting it asks first, naming them. */
  referencedBy: { type: string; label: string; count: number }[];
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

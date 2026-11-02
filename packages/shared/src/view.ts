import { z } from "zod";

/**
 * A pipeline's page (M27): how the collection its data.save keeps is shown, in the menu, as a list and per row, with
 * my own marks and buttons that start pipelines. Declarative only: fields by path, a fixed set of formats, no
 * templates and no HTML, so nothing a page or an email put into a row can do more than be shown as text.
 */

/** The same names as data.save's `collection`. */
export const VIEW_COLLECTION = /^[a-z][a-z0-9._-]{0,63}$/;

/** A field of a row's value by dotted path ("company.name"), or what AI ME knows of the row itself. */
const FIELD_PATH = /^[A-Za-z_$][\w$-]{0,63}(\.[\w$-]{1,64}){0,5}$/;
export const ROW_FIELDS = ["@key", "@firstSeen", "@lastSeen"] as const;
export type RowField = (typeof ROW_FIELDS)[number];

const FieldSchema = z.union([
  z.enum(ROW_FIELDS),
  z.string().regex(FIELD_PATH, 'a field of the item by dotted path, e.g. "title" or "company.name"'),
]);

export const VIEW_FORMATS = ["text", "number", "money", "date", "datetime", "badge", "link", "yesno"] as const;
export type ViewFormat = (typeof VIEW_FORMATS)[number];

/** The menu's icons: plain signifiers, mapped to Tabler icons by the web app. */
export const VIEW_ICONS = [
  "list",
  "package",
  "news",
  "rss",
  "bell",
  "tag",
  "star",
  "bookmark",
  "calendar",
  "chart",
  "world",
  "home",
  "car",
  "book",
  "cpu",
  "heart",
] as const;
export type ViewIcon = (typeof VIEW_ICONS)[number];

export const ViewColumnSchema = z.union([
  FieldSchema.transform((field) => ({ field, as: "text" as const })),
  z
    .object({
      field: FieldSchema,
      label: z.string().trim().min(1).max(40).optional(),
      as: z.enum(VIEW_FORMATS).default("text"),
      /** For money: the field holding the currency code. */
      currency: FieldSchema.optional(),
    })
    .strict(),
]);
export type ViewColumn = z.output<typeof ViewColumnSchema>;

/** "-@firstSeen" or { by, desc }. */
const SortSchema = z.union([
  z
    .string()
    .regex(/^-?\S+$/)
    .transform((text) => ({ by: text.replace(/^-/, ""), desc: text.startsWith("-") }))
    .pipe(z.object({ by: FieldSchema, desc: z.boolean() })),
  z.object({ by: FieldSchema, desc: z.boolean().default(false) }).strict(),
]);

const MARK_ID = /^[a-z][a-z0-9_]{0,29}$/;

/** A mark I set on a row by hand ("done", "read"); data.save never touches it. `hides`: marked rows leave the list. */
export const ViewMarkSchema = z
  .object({
    id: z.string().regex(MARK_ID, "lowercase letters, digits and _, e.g. done"),
    label: z.string().trim().min(1).max(30),
    hides: z.boolean().default(false),
  })
  .strict();
export type ViewMark = z.infer<typeof ViewMarkSchema>;

/**
 * A button: `run` starts a pipeline by name, or "self". On the page (row: false) it starts one that is manual or
 * scheduled; on a row, one triggered by { on: view.action }, which gets the row as {{trigger.item}}. Either way the
 * run is an ordinary one: its gates, the policy and the kill switch hold.
 */
export const ViewActionSchema = z
  .object({
    label: z.string().trim().min(1).max(30),
    run: z.string().trim().min(1).max(100),
    row: z.boolean().default(false),
    /** Asked before starting, e.g. "Draft upgrade notes for this release?". */
    confirm: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type ViewAction = z.infer<typeof ViewActionSchema>;

export const PipelineViewSchema = z
  .object({
    menu: z.object({ label: z.string().trim().min(1).max(30), icon: z.enum(VIEW_ICONS).default("list") }).strict(),
    /** The collection a data.save step of this pipeline writes. */
    collection: z.string().regex(VIEW_COLLECTION, "lowercase letters, digits, . _ -, e.g. releases"),
    columns: z.array(ViewColumnSchema).min(1).max(8),
    /** The row's name on its own page; default: the first column. */
    title: FieldSchema.optional(),
    /** An http(s) address of the row, opened from the list and the row's page. */
    link: FieldSchema.optional(),
    sort: SortSchema.default({ by: "@firstSeen", desc: true }),
    /** A Removed tab, for a collection saved with complete: true. */
    removed: z.boolean().default(false),
    detail: z
      .object({
        /** Default: every field of the row. */
        fields: z.array(FieldSchema).min(1).max(30).optional(),
        /** A data.history collection of this pipeline, by the same key: drawn as a chart. */
        history: z.string().regex(VIEW_COLLECTION).optional(),
      })
      .strict()
      .default({}),
    marks: z.array(ViewMarkSchema).max(5).default([]),
    actions: z.array(ViewActionSchema).max(6).default([]),
  })
  .strict();
export type PipelineView = z.output<typeof PipelineViewSchema>;

// --- the api (M27) ---

/** A pipeline with a page, for the menu. */
export interface ViewMenuItem {
  pipelineId: string;
  pipelineName: string;
  label: string;
  icon: ViewIcon;
}

export interface ViewRow {
  key: string;
  value: Record<string, unknown>;
  /** Mark id → when I set it. */
  marks: Record<string, string>;
  firstSeenAt: string;
  lastSeenAt: string;
  removedAt: string | null;
}

/** A column's value: a field of the row's value by dotted path, or @key / @firstSeen / @lastSeen. */
export function fieldOf(row: ViewRow, path: string): unknown {
  if (path === "@key") return row.key;
  if (path === "@firstSeen") return row.firstSeenAt;
  if (path === "@lastSeen") return row.lastSeenAt;
  let current: unknown = row.value;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** An address the page may link to: http(s) only, so a row can't carry a javascript: or data: link. */
export function safeLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** "current": not removed and not hidden by a mark; "removed"; or "mark:<id>". */
export const ViewTabSchema = z.union([z.enum(["current", "removed"]), z.string().regex(/^mark:[a-z][a-z0-9_]{0,29}$/)]);
export type ViewTab = z.infer<typeof ViewTabSchema>;

export const ViewQuerySchema = z
  .object({
    tab: ViewTabSchema.default("current"),
    q: z.string().trim().max(200).optional(),
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type ViewQuery = z.infer<typeof ViewQuerySchema>;

export interface ViewHeader {
  pipelineId: string;
  pipelineName: string;
  version: number;
  view: PipelineView;
}

export interface ViewPageView extends ViewHeader {
  rows: ViewRow[];
  /** Matching rows in the tab (before paging). */
  total: number;
  /** Rows per tab, without the search. */
  counts: Record<string, number>;
}

export interface ViewRowView extends ViewHeader {
  row: ViewRow;
  /** The detail's data.history values for this row, oldest first; null without detail.history. */
  history: { at: string; value: number }[] | null;
}

export const ViewMarkRequestSchema = z.object({ on: z.boolean() }).strict();
export type ViewMarkRequest = z.infer<typeof ViewMarkRequestSchema>;

export const ViewActionRequestSchema = z.object({ key: z.string().min(1).max(2000).optional() }).strict();
export type ViewActionRequest = z.infer<typeof ViewActionRequestSchema>;

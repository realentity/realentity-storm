import { z } from "zod";

/**
 * How an App's pages show a value (they began as M27's pipeline pages): fields by path, a fixed set of formats, no
 * templates and no HTML, so nothing a page or an email put into a row can do more than be shown as text.
 */

/** A field of a row's value by dotted path ("company.name"), or what Storm knows of the row itself. */
const FIELD_PATH = /^[A-Za-z_$][\w$-]{0,63}(\.[\w$-]{1,64}){0,5}$/;
const ROW_FIELDS = ["@key", "@firstSeen", "@lastSeen"] as const;

const FieldSchema = z.union([
  z.enum(ROW_FIELDS),
  z.string().regex(FIELD_PATH, 'a field of the item by dotted path, e.g. "title" or "company.name"'),
]);

/** M46: `file` a download link, `image` a thumbnail; both only of a stored file's reference ({ id, name, mime, size }). */
export const VIEW_FORMATS = ["text", "number", "money", "date", "datetime", "badge", "link", "yesno", "file", "image"] as const;
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
  "briefcase",
  "receipt",
  "cloud",
  "lock",
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

/** At most this many lines on a page's chart (M29-T8): the categorical palette's slots, never a sixth colour. */
export const CHART_SERIES = 5;

export interface ViewRow {
  key: string;
  value: Record<string, unknown>;
  /** Mark id → when it was set. */
  marks: Record<string, string>;
  firstSeenAt: string;
  lastSeenAt: string;
  removedAt: string | null;
  /** M56: an App's ref fields by what they point at: its title (a list of refs: theirs, in order), as shown. */
  titles?: Record<string, string>;
  /** M65-T8: in a list grouped by a list of text, the group this row is shown under (a row in each of its values'). */
  group?: string | null;
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

export interface ViewChart {
  /** By latest value, highest first; at most CHART_SERIES. `label`: the row's title when the key is a row. */
  series: { key: string; label: string; points: { at: string; value: number }[] }[];
  /** Keys kept but not drawn. */
  more: number;
}

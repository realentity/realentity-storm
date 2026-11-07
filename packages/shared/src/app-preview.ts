import { z } from "zod";
import { type DataType } from "./app";
import { type AppListView, type ResolvedViewPage } from "./app-pages";
import { type ViewRow } from "./view";

/**
 * M37-T2: a page of a draft App, as it would look: its list with the App's entities of that type (or a few made up
 * from its fields when it has none), and the first one's own page. Nothing is saved.
 */

export const AppPreviewRequestSchema = z
  .object({
    source: z.string().max(200_000),
    /** The App it is a draft of: its entities are shown. */
    appId: z.uuid().optional(),
    type: z.string().min(1).max(60),
  })
  .strict();
export type AppPreviewRequest = z.infer<typeof AppPreviewRequestSchema>;

export interface AppPreviewView {
  list: AppListView;
  /** The first row's own page; null without rows. */
  view: { page: ResolvedViewPage; row: ViewRow } | null;
  /** The rows are made up from the type's fields: it has no entities yet. */
  sample: boolean;
}

/** How many rows a preview shows. */
export const PREVIEW_ROWS = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A few entities made up from a type's fields, to show its pages before it has any: each value of its kind, spread so
 * that groups, sorts and due dates show (dates from two weeks ago to a month on, an enum's or a stage's every value).
 */
export function sampleRows(typeName: string, type: DataType, count = 6, now = new Date()): ViewRow[] {
  const currencies = new Set(Object.values(type.fields).flatMap((f) => (f.currency ? [f.currency] : [])));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const date = new Date(today + (i * 9 - 14) * DAY_MS).toISOString();
    const value: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(type.fields)) {
      if (currencies.has(name)) {
        value[name] = "EUR";
        continue;
      }
      switch (field.type) {
        case "number":
          value[name] = n * 7;
          break;
        case "money":
          value[name] = Math.round(n * 1234.5) / 100;
          break;
        case "date":
          value[name] = date.slice(0, 10);
          break;
        case "datetime":
          value[name] = date;
          break;
        case "url":
          value[name] = `https://example.org/${typeName.toLowerCase()}/${n}`;
          break;
        case "email":
          value[name] = `someone${n}@example.org`;
          break;
        case "yesno":
          value[name] = i % 2 === 0;
          break;
        case "enum":
          value[name] = field.values?.length ? field.values[i % field.values.length] : null;
          break;
        case "list":
          value[name] = ["one", "two"];
          break;
        case "longtext":
          value[name] = `A longer ${name} of ${typeName} ${n}, a sentence or two as it would come.`;
          break;
        default:
          value[name] = `${name} ${n}`;
      }
    }
    if (type.stages) value[type.stages.field] = type.stages.states[i % type.stages.states.length];
    const key = typeof value[type.key] === "string" || typeof value[type.key] === "number" ? String(value[type.key]) : `${typeName}-${n}`;
    const seen = new Date(now.getTime() - i * DAY_MS).toISOString();
    return { key, value, marks: {}, firstSeenAt: seen, lastSeenAt: seen, removedAt: null };
  });
}

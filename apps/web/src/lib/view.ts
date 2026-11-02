import { fieldOf, type PipelineView, type ViewColumn, type ViewIcon, type ViewRow } from "@ai-me/shared";
import {
  IconBell,
  IconBook,
  IconBookmark,
  IconCalendar,
  IconCar,
  IconChartLine,
  IconCpu,
  IconHeart,
  IconHome,
  IconList,
  IconNews,
  IconPackage,
  IconRss,
  IconStar,
  IconTag,
  IconWorld,
  type Icon,
} from "@tabler/icons-react";

export const VIEW_ICON: Record<ViewIcon, Icon> = {
  list: IconList,
  package: IconPackage,
  news: IconNews,
  rss: IconRss,
  bell: IconBell,
  tag: IconTag,
  star: IconStar,
  bookmark: IconBookmark,
  calendar: IconCalendar,
  chart: IconChartLine,
  world: IconWorld,
  home: IconHome,
  car: IconCar,
  book: IconBook,
  cpu: IconCpu,
  heart: IconHeart,
};

/** A row's name: its title field, else its first column, else its key. */
export function rowTitle(view: PipelineView, row: ViewRow): string {
  const value = fieldOf(row, view.title ?? view.columns[0].field);
  return value === undefined || value === null || value === "" ? row.key : asText(value);
}

/** A column's label: as written, else the field's last segment. */
export function columnLabel(column: ViewColumn): string {
  if ("label" in column && column.label) return column.label;
  if (column.field === "@firstSeen") return "First seen";
  if (column.field === "@lastSeen") return "Last seen";
  if (column.field === "@key") return "Key";
  const last = column.field.split(".").at(-1)!;
  return (
    last.charAt(0).toUpperCase() +
    last
      .slice(1)
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
  );
}

export function toNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/\s/g, "").replace(",", ".")) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Text for any JSON value: a list of plain values joined, anything else as JSON. */
export function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v !== "object" || v === null)) return value.join(", ");
  return JSON.stringify(value);
}

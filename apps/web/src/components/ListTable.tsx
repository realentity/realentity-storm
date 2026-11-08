import {
  actionApplies,
  entityValueAt,
  fieldOf,
  groupValue,
  type EntityGroup,
  type PageColumn,
  type ResolvedListPage,
  type ViewRow,
} from "@ai-me/shared";
import { IconArrowDown, IconArrowUp, IconGripVertical, IconLayoutList } from "@tabler/icons-react";
import { Fragment, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { asText } from "../lib/view";
import { EntityLink } from "./EntityLink";
import { ViewValue } from "./ViewParts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NUMBER = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });

/** What the preview (M37-T2) does on the headings: a column dragged, a sort and a group picked. */
export interface TableDesign {
  onMove: (from: number, to: number) => void;
  onSort: (field: string) => void;
  onGroup: (field: string | null) => void;
}

/**
 * A type's list as a table (M31): its columns, the rows in their groups with counts and totals, a due badge, each row's
 * stage moves and link. The App's list page and the designer's preview (with `design`) draw it the same way.
 */
export function ListTable({
  page,
  rows,
  groups,
  rowLink,
  moves,
  design,
}: Readonly<{
  page: ResolvedListPage;
  rows: ViewRow[];
  groups: EntityGroup[] | null;
  /** Where a row's title links to; null: no link (the preview). */
  rowLink: (row: ViewRow) => string | null;
  /** The buttons for a row's stage moves; without it, they are shown but do nothing. */
  moves?: (row: ViewRow, to: string) => ReactNode;
  design?: TableDesign;
}>) {
  const [dragged, setDragged] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  return (
    <div className="table-responsive">
      <table className="table table-vcenter card-table">
        <thead>
          <tr>
            {page.columns.map((c, i) => (
              <th
                key={c.field}
                draggable={design !== undefined}
                onDragStart={design ? () => setDragged(i) : undefined}
                onDragOver={
                  design
                    ? (e) => {
                        e.preventDefault();
                        setOver(i);
                      }
                    : undefined
                }
                onDragEnd={() => (setDragged(null), setOver(null))}
                onDrop={
                  design
                    ? (e) => {
                        e.preventDefault();
                        if (dragged !== null && dragged !== i) design.onMove(dragged, i);
                        setDragged(null);
                        setOver(null);
                      }
                    : undefined
                }
                className={design && over === i && dragged !== i ? "bg-primary-lt" : undefined}
                data-testid="list-heading"
                data-field={c.field}
              >
                {design ? <DesignHeading column={c} page={page} design={design} /> : c.label}
              </th>
            ))}
            <th className="w-1" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const group = groups && page.group ? groupOf(groups, row, page.group.by.field, page.group.period) : null;
            const first = group && (i === 0 || groupOf(groups!, rows[i - 1], page.group!.by.field, page.group!.period) !== group);
            const link = rowLink(row);
            return (
              <Fragment key={row.key}>
                {first && (
                  <tr className="bg-secondary-lt" data-testid="entity-group">
                    <td colSpan={page.columns.length + 1}>
                      <strong>{group.label}</strong>
                      <span className="text-secondary ms-2">{group.count}</span>
                      {group.totals.map((t, j) => (
                        <span key={j} className="ms-3 text-secondary" data-testid="group-total">
                          {page.group!.totals[j]?.label}:{" "}
                          <strong className="text-reset">{sums(t.sums, page.group!.totals[j]?.as === "money")}</strong>
                        </span>
                      ))}
                    </td>
                  </tr>
                )}
                <tr data-testid="entity-row">
                  {page.columns.map((c) => (
                    <td key={c.field}>
                      {c.field === page.title && link ? (
                        <Link to={link}>
                          <ViewValue row={row} column={{ ...c, as: c.as === "link" ? "text" : c.as }} inLink />
                        </Link>
                      ) : (
                        <ViewValue row={row} column={c} />
                      )}
                      {c.due && <DueBadge row={row} field={c.field} due={c.due} />}
                    </td>
                  ))}
                  <td className="text-end text-nowrap">
                    {page.moves &&
                      (page.moves.to[asText(fieldOf(row, page.moves.field))] ?? []).map((to) =>
                        moves ? (
                          <Fragment key={to}>{moves(row, to)}</Fragment>
                        ) : (
                          <span key={to} className="btn btn-sm me-1 disabled">
                            {to}
                          </span>
                        ),
                      )}
                    <EntityLink row={row} field={page.link} />
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A heading in the preview: dragged by its grip; its name sorts by it (again: the other way); its button groups by it. */
function DesignHeading({ column, page, design }: Readonly<{ column: PageColumn; page: ResolvedListPage; design: TableDesign }>) {
  const sorted = page.sort.by === column.field;
  const grouped = page.group?.by.field === column.field;
  return (
    <span className="d-inline-flex align-items-center gap-1 text-nowrap">
      <IconGripVertical size={14} className="text-secondary" style={{ cursor: "grab" }} aria-hidden />
      <button
        type="button"
        className="border-0 bg-transparent p-0 text-reset fw-bold text-uppercase"
        style={{ fontSize: "inherit", letterSpacing: "inherit" }}
        onClick={() => design.onSort(column.field)}
        title={sorted ? "Sorted by this: click for the other way" : "Sort by this"}
        data-testid="heading-sort"
      >
        {column.label}
      </button>
      {sorted &&
        (page.sort.desc ? <IconArrowDown size={14} aria-label="highest first" /> : <IconArrowUp size={14} aria-label="lowest first" />)}
      <button
        type="button"
        className={`border-0 bg-transparent p-0 d-inline-flex ${grouped ? "text-primary" : "text-secondary"}`}
        onClick={() => design.onGroup(grouped ? null : column.field)}
        title={grouped ? "In groups by this: click for no groups" : "In groups by this"}
        aria-label={grouped ? `No groups by ${column.label}` : `In groups by ${column.label}`}
        data-testid="heading-group"
      >
        <IconLayoutList size={14} />
      </button>
    </span>
  );
}

function groupOf(groups: EntityGroup[], row: ViewRow, field: string, period: "month" | "year" | null): EntityGroup | null {
  const value = groupValue(fieldOf(row, field), period);
  return groups.find((g) => g.value === value) ?? null;
}

/** A date that is near, as a badge (M33): overdue, today, in N days; nothing when the entity is as `unless` says. */
function DueBadge({
  row,
  field,
  due,
}: Readonly<{ row: ViewRow; field: string; due: { days: number; unless?: Record<string, string | boolean | string[]> } }>) {
  const value = fieldOf(row, field);
  if (typeof value !== "string" || (due.unless && actionApplies({ when: due.unless }, row.value, entityValueAt))) return null;
  // Whole calendar days from today (here) to the date: yesterday is -1, whatever the hour.
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((Date.parse(`${value.slice(0, 10)}T00:00:00Z`) - today) / DAY_MS);
  if (days < 0)
    return (
      <span className="badge bg-red-lt ms-2" data-testid="due-badge">
        overdue
      </span>
    );
  if (days <= due.days)
    return (
      <span className="badge bg-yellow-lt ms-2" data-testid="due-badge">
        {days === 0 ? "today" : `in ${days} d`}
      </span>
    );
  return null;
}

/** "1250.00 BGN · 300.00 EUR": money as the rows show it. */
function sums(byCurrency: Record<string, number>, money: boolean): string {
  const entries = Object.entries(byCurrency);
  if (entries.length === 0) return "—";
  return entries.map(([currency, sum]) => `${money ? sum.toFixed(2) : NUMBER.format(sum)}${currency ? ` ${currency}` : ""}`).join(" · ");
}

import type { PageFilter, SourceView } from "@realentity/storm-shared";
import { IconChevronLeft, IconChevronRight } from "@tabler/icons-react";
import { useState } from "react";

/**
 * M65-T5: a list's filter as its control draws it: a dropdown (several picked with `multiple`), buttons or chips of
 * its values, a date input, or a calendar (a month with the days that have entities marked; a day picks it, again
 * clears). Its choices come from the page's source, else the filter's own values.
 */

interface Choice {
  value: string;
  label: string;
  count?: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function choicesOf(filter: PageFilter, source: SourceView | undefined, picked: readonly string[]): Choice[] {
  let choices: Choice[] = filter.values;
  if (source?.kind === "values") choices = source.values;
  else if (source?.kind === "items") choices = source.items.map((item) => ({ value: item.id, label: item.label }));
  // A caseless list's choice is the picked one in another spelling ("Home" when "home" is picked): it takes the picked.
  const same = (a: string, b: string) => (filter.caseless ? a.toLowerCase() === b.toLowerCase() : a === b);
  choices = choices.map((c) => {
    const as = picked.find((v) => same(v, c.value));
    return as === undefined ? c : { ...c, value: as };
  });
  // A value in the link that nothing has now is still shown, picked.
  const missing = picked.filter((v) => !choices.some((c) => c.value === v)).map((value) => ({ value, label: value }));
  return [...choices, ...missing];
}

export function FilterControl({
  filter,
  source,
  value,
  onChange,
}: Readonly<{
  filter: PageFilter;
  source: SourceView | undefined;
  /** What is picked: none (all), one, or several. */
  value: readonly string[];
  onChange: (values: string[]) => void;
}>) {
  const testId = `filter-${filter.field}`;
  if (filter.control === "calendar") {
    const days = new Map(source?.kind === "values" ? source.values.map((v) => [v.value, v.count]) : []);
    return <Calendar label={filter.label} testId={testId} days={days} value={value[0]} onPick={(day) => onChange(day ? [day] : [])} />;
  }
  if (filter.control === "date") {
    return (
      <input
        type="date"
        className="form-control form-control-sm w-auto"
        aria-label={filter.label}
        title={filter.label}
        value={value[0] && DAY.test(value[0]) ? value[0] : ""}
        onChange={(e) => onChange(e.target.value ? [e.target.value] : [])}
        data-testid={testId}
      />
    );
  }
  const choices = choicesOf(filter, source, value);
  const toggle = (v: string) => {
    if (!filter.multiple) return onChange(value.includes(v) ? [] : [v]);
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  };
  if (filter.control === "dropdown") {
    if (filter.multiple) {
      return (
        <select
          multiple
          className="form-select form-select-sm w-auto"
          aria-label={filter.label}
          size={Math.min(Math.max(choices.length, 2), 5)}
          value={[...value]}
          onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))}
          data-testid={testId}
        >
          {choices.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
              {c.count === undefined ? "" : ` (${c.count})`}
            </option>
          ))}
        </select>
      );
    }
    return (
      <select
        className="form-select form-select-sm w-auto"
        aria-label={filter.label}
        value={value[0] ?? ""}
        onChange={(e) => onChange(e.target.value ? [e.target.value] : [])}
        data-testid={testId}
      >
        <option value="">{filter.label}: all</option>
        {choices.map((c) => (
          <option key={c.value} value={c.value}>
            {filter.label}: {c.label}
            {c.count === undefined ? "" : ` (${c.count})`}
          </option>
        ))}
      </select>
    );
  }
  // Buttons or chips: each a toggle; "All" clears.
  const chips = filter.control === "chips";
  const shape = (on: boolean) => {
    if (chips) return `btn btn-sm btn-pill ${on ? "btn-azure" : "btn-outline-azure"}`;
    return `btn btn-sm ${on ? "btn-primary" : ""}`;
  };
  return (
    <fieldset className="d-flex flex-wrap gap-1 align-items-center border-0 p-0 m-0" aria-label={filter.label} data-testid={testId}>
      <legend className="text-secondary small me-1 mb-0 float-none w-auto">{filter.label}:</legend>
      <button type="button" className={shape(value.length === 0)} aria-pressed={value.length === 0} onClick={() => onChange([])}>
        All
      </button>
      {choices.map((c) => {
        const on = value.includes(c.value);
        return (
          <button key={c.value} type="button" className={shape(on)} aria-pressed={on} onClick={() => toggle(c.value)} data-value={c.value}>
            {c.label}
            {c.count !== undefined && <span className={`badge ms-1 ${on ? "bg-white text-reset" : "bg-secondary-lt"}`}>{c.count}</span>}
          </button>
        );
      })}
    </fieldset>
  );
}

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTH = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const LONG_DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** Today as the browser's clock has it: 2026-11-25. */
function today(): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

/** "2026-11-25" → "25 November 2026". */
function longDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return LONG_DAY.format(Date.UTC(y, m - 1, d));
}

/** "2026-11" moved by `by` months. */
function shift(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** A month's days in weeks from Monday; null where a week starts before the month or ends after it. */
function weeksOf(month: string): (string | null)[][] {
  const [y, m] = month.split("-").map(Number);
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`),
  ];
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}

/** The month first shown: the picked day's, else the latest marked day's, else this one. */
function firstMonth(value: string | undefined, days: ReadonlyMap<string, number>): string {
  if (value && DAY.test(value)) return value.slice(0, 7);
  const latest = [...days.keys()].sort((a, b) => a.localeCompare(b)).at(-1);
  return (latest ?? today()).slice(0, 7);
}

function Calendar({
  label,
  testId,
  days,
  value,
  onPick,
}: Readonly<{
  label: string;
  testId: string;
  /** The days with entities, and how many. */
  days: ReadonlyMap<string, number>;
  value: string | undefined;
  onPick: (day: string | null) => void;
}>) {
  const [month, setMonth] = useState(() => firstMonth(value, days));
  const now = today();
  const [y, m] = month.split("-").map(Number);
  return (
    <div className="card" data-testid={testId} aria-label={label}>
      <div className="card-header py-2 d-flex align-items-center gap-1">
        <button
          type="button"
          className="btn btn-sm btn-ghost-secondary btn-icon"
          aria-label="Previous month"
          onClick={() => setMonth(shift(month, -1))}
        >
          <IconChevronLeft size={16} />
        </button>
        <strong className="mx-auto" data-testid="calendar-month">
          {MONTH.format(Date.UTC(y, m - 1, 1))}
        </strong>
        <button
          type="button"
          className="btn btn-sm btn-ghost-secondary btn-icon"
          aria-label="Next month"
          onClick={() => setMonth(shift(month, 1))}
        >
          <IconChevronRight size={16} />
        </button>
      </div>
      <table className="table table-sm table-borderless text-center mb-0" aria-label={`${label}, ${MONTH.format(Date.UTC(y, m - 1, 1))}`}>
        <thead>
          <tr>
            {WEEKDAYS.map((d) => (
              <th key={d} className="text-secondary fw-normal small px-0">
                {d}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeksOf(month).map((week) => (
            <tr key={week.find(Boolean) ?? ""}>
              {week.map((day, i) => {
                if (!day) return <td key={`blank-${i}`} className="p-0" />;
                const count = days.get(day) ?? 0;
                const picked = day === value;
                let shape = "btn-ghost-secondary";
                if (picked) shape = "btn-primary";
                else if (count) shape = "btn-ghost-primary fw-bold";
                const name = longDay(day);
                let dot = "";
                if (count) dot = picked ? "bg-white" : "bg-primary";
                return (
                  <td key={day} className="p-0">
                    <button
                      type="button"
                      className={`btn btn-sm w-100 px-0 flex-column ${shape} ${day === now && !picked ? "border-primary" : ""}`}
                      aria-pressed={picked}
                      aria-label={count ? `${name}: ${count}` : name}
                      title={count ? `${count}` : undefined}
                      onClick={() => onPick(picked ? null : day)}
                      data-day={day}
                      data-count={count || undefined}
                    >
                      {Number(day.slice(8))}
                      <span className={`d-block rounded-circle mx-auto ${dot}`} style={{ width: 4, height: 4 }} />
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {value && (
        <div className="card-footer py-2 small d-flex align-items-center">
          <span className="text-secondary">{DAY.test(value) ? longDay(value) : value}</span>
          <button type="button" className="btn btn-sm btn-link ms-auto p-0" onClick={() => onPick(null)} data-testid={`${testId}-clear`}>
            All days
          </button>
        </div>
      )}
    </div>
  );
}

import {
  DISTINCT_KINDS,
  fieldLabel,
  filterControlsOf,
  kindOfField,
  LIST_FILTER_KINDS,
  setPageProperty,
  type AppDefinition,
  type FieldKind,
  type FilterControl,
} from "@realentity/storm-shared";
import { IconTrash } from "@tabler/icons-react";
import { asObject, text } from "../lib/loose-app";
import { HELP } from "../lib/help";
import { Help } from "./Help";
import { type DesignerEdit } from "./TypesDesigner";

/**
 * M65-T6: a list page's sources (what its controls pick from: a field's values with counts, or a date's days) and its
 * controls (a filter drawn as buttons, chips, a calendar…), each an edit of the page's YAML. A control added gets its
 * kind's usual drawing and, where it counts something, a source of its own: a list's values as chips, a date's days
 * on a calendar. A source of entities (`where`, `sort`) is written in the YAML; it is shown and can be removed here.
 */

type Raw = Record<string, unknown>;

const META = ["@firstSeen", "@lastSeen"];
const DAY_KINDS = new Set<FieldKind | undefined>(["date", "datetime"]);
const CONTROL_LABEL: Record<FilterControl, string> = {
  dropdown: "a dropdown",
  buttons: "buttons",
  chips: "chips",
  calendar: "a calendar",
  date: "a date input",
};

const isDays = (source: Raw) => source.by === "day";
const isValues = (source: Raw) => typeof source.distinct === "string";

/** "@firstSeen" → "firstSeen"; "due" with days → "dueDays"; another number when taken. */
function sourceName(field: string, days: boolean, taken: readonly string[]): string {
  const base = field.replace(/^@/, "").replaceAll(/[^A-Za-z0-9]/g, "") || "values";
  const name = (base.charAt(0).toLowerCase() + base.slice(1) + (days ? "Days" : "")).slice(0, 36);
  let next = name;
  for (let n = 2; taken.includes(next); n++) next = `${name}${n}`;
  return next;
}

export function ControlsDesigner({
  app,
  type,
  rawSources,
  rawControls,
  filters,
  editable,
  onEdit,
}: Readonly<{
  app: AppDefinition;
  type: string;
  rawSources: unknown;
  rawControls: unknown;
  /** The fields `filters:` filters by: a control can't filter by them too. */
  filters: string[];
  editable: boolean;
  onEdit: (edit: DesignerEdit) => void;
}>) {
  const def = app.types[type];
  const sources = Object.entries(asObject(rawSources)).map(([name, s]) => [name, asObject(s)] as const);
  const controls = (Array.isArray(rawControls) ? rawControls : []).map(asObject);
  const label = (of: string, field: string) => (Object.hasOwn(app.types, of) ? fieldLabel(app.types[of], field) : field);
  const kindOf = (of: string, field: string) => (Object.hasOwn(app.types, of) ? kindOfField(app.types[of], field) : undefined);

  /** Both written at once: a control and the source it gets. */
  const write = (nextSources: (readonly [string, Raw])[], nextControls: Raw[]) =>
    onEdit((s) => {
      const withSources = setPageProperty(s, "list", type, "sources", nextSources.length ? Object.fromEntries(nextSources) : undefined);
      return setPageProperty(withSources, "list", type, "controls", nextControls.length ? nextControls : undefined);
    });

  /** The source a control on a field uses: one that counts it already, else a new one (a list's values, a date's days). */
  const sourceFor = (control: FilterControl, field: string, kind: FieldKind | undefined) => {
    if (control === "date" || (control !== "calendar" && kind !== "list")) return { name: undefined, add: null };
    const days = control === "calendar";
    const found = sources.find(([, s]) => s.from === type && s.distinct === field && isDays(s) === days);
    if (found) return { name: found[0], add: null };
    const name = sourceName(field, days, sources.map(([n]) => n));
    return { name, add: [name, { from: type, distinct: field, ...(days ? { by: "day" } : {}) }] as const };
  };

  /** A control as written: its kind, its source, the field, several only when so; anything else it had kept. */
  const controlOf = (old: Raw, patch: { control: FilterControl; source?: string; multiple?: boolean }): Raw => {
    const rest = Object.fromEntries(Object.entries(old).filter(([key]) => !["control", "source", "filters", "multiple"].includes(key)));
    const days = patch.control === "calendar" || patch.control === "date";
    return {
      control: patch.control,
      ...(patch.source ? { source: patch.source } : {}),
      filters: old.filters,
      ...(patch.multiple && !days ? { multiple: true } : {}),
      ...rest,
    };
  };

  const filtered = new Set([...filters, ...controls.map((c) => text(c.filters))]);
  const addable = [...Object.keys(def.fields), ...META].filter((f) => !filtered.has(f) && LIST_FILTER_KINDS.includes(kindOf(type, f)!));

  const addControl = (field: string) => {
    const kind = kindOf(type, field);
    let control: FilterControl = "buttons";
    if (DAY_KINDS.has(kind)) control = "calendar";
    else if (kind === "list") control = "chips";
    const { name, add } = sourceFor(control, field, kind);
    write(add ? [...sources, add] : sources, [...controls, controlOf({ filters: field }, { control, source: name, multiple: kind === "list" })]);
  };

  const changeControl = (i: number, patch: { control?: FilterControl; source?: string | null; multiple?: boolean }) => {
    const old = controls[i];
    const field = text(old.filters);
    const kind = kindOf(type, field);
    const control = patch.control ?? (text(old.control) as FilterControl);
    let source = patch.source === null ? undefined : (patch.source ?? (text(old.source) || undefined));
    let nextSources = sources;
    // A source that doesn't suit the new control: the one that does (a calendar's days), or none.
    const current = sources.find(([n]) => n === source)?.[1];
    if (patch.control && (control === "date" || (current && isDays(current) !== (control === "calendar")) || (control === "calendar" && !current))) {
      const fit = sourceFor(control, field, kind);
      source = fit.name;
      if (fit.add) nextSources = [...sources, fit.add];
    }
    const multiple = patch.multiple ?? old.multiple === true;
    write(
      nextSources,
      controls.map((c, j) => (j === i ? controlOf(old, { control, source, multiple }) : c)),
    );
  };

  const removeSource = (name: string) =>
    write(
      sources.filter(([n]) => n !== name),
      controls.map((c) => (c.source === name ? controlOf(c, { control: text(c.control) as FilterControl, multiple: c.multiple === true }) : c)),
    );

  const changeSource = (name: string, patch: Raw) =>
    write(
      sources.map(([n, s]): readonly [string, Raw] => {
        if (n !== name) return [n, s];
        const next: Raw = { ...s, ...patch };
        for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
        return [n, next];
      }),
      controls,
    );

  const distinctOf = (of: string) =>
    Object.hasOwn(app.types, of)
      ? [...Object.keys(app.types[of].fields), ...META].filter((f) => DISTINCT_KINDS.includes(kindOf(of, f)!) && !app.types[of].fields[f]?.encrypted)
      : [];

  const addSource = (field: string) => {
    const days = DAY_KINDS.has(kindOf(type, field));
    const name = sourceName(field, days, sources.map(([n]) => n));
    write([...sources, [name, { from: type, distinct: field, ...(days ? { by: "day" } : {}) }]], controls);
  };

  return (
    <>
      <div className="row mb-2 align-items-baseline" data-help={HELP.pageControls}>
        <div className="col-4 col-xl-3 text-secondary small">
          Controls <Help text={HELP.pageControls} />
        </div>
        <div className="col d-flex flex-column gap-1" data-testid="page-controls">
          {controls.map((c, i) => {
            const field = text(c.filters);
            const kind = kindOf(type, field);
            const control = text(c.control) as FilterControl;
            const fitting = sources.filter(([, s]) => isValues(s) && isDays(s) === (control === "calendar"));
            return (
              <div key={field || i} className="d-flex flex-wrap gap-2 align-items-center" data-testid="page-control" data-field={field}>
                <span className="badge bg-blue-lt">{label(type, field)}</span>
                <span className="text-secondary small">as</span>
                <select
                  className="form-select form-select-sm w-auto"
                  value={control}
                  disabled={!editable}
                  onChange={(e) => changeControl(i, { control: e.target.value as FilterControl })}
                  aria-label={`${label(type, field)}'s control`}
                  data-testid="page-control-kind"
                >
                  {filterControlsOf(kind).map((k) => (
                    <option key={k} value={k}>
                      {CONTROL_LABEL[k]}
                    </option>
                  ))}
                </select>
                {control !== "date" && (
                  <select
                    className="form-select form-select-sm w-auto"
                    value={text(c.source)}
                    disabled={!editable}
                    onChange={(e) => changeControl(i, { source: e.target.value || null })}
                    aria-label={`${label(type, field)}'s choices from`}
                    data-testid="page-control-source"
                  >
                    <option value="">{control === "calendar" ? "no days marked" : "its own values"}</option>
                    {c.source !== undefined && !fitting.some(([n]) => n === c.source) && <option value={text(c.source)}>{text(c.source)}</option>}
                    {fitting.map(([n]) => (
                      <option key={n} value={n}>
                        from {n}
                      </option>
                    ))}
                  </select>
                )}
                {control !== "date" && control !== "calendar" && (
                  <label className="form-check form-check-inline mb-0 me-0">
                    <input
                      type="checkbox"
                      className="form-check-input"
                      checked={c.multiple === true}
                      disabled={!editable}
                      onChange={(e) => changeControl(i, { multiple: e.target.checked })}
                      aria-label={`${label(type, field)}: several`}
                      data-testid="page-control-multiple"
                    />
                    <span className="form-check-label small">several</span>
                  </label>
                )}
                {editable && (
                  <button
                    type="button"
                    className="btn btn-ghost-danger btn-icon btn-sm"
                    aria-label={`Remove ${label(type, field)}'s control`}
                    onClick={() => write(sources, controls.filter((_, j) => j !== i))}
                  >
                    <IconTrash size={16} />
                  </button>
                )}
              </div>
            );
          })}
          {editable && addable.length > 0 && controls.length < 6 && (
            <select
              className="form-select form-select-sm w-auto"
              value=""
              onChange={(e) => e.target.value && addControl(e.target.value)}
              aria-label="Add a control"
              data-testid="page-controls-add"
            >
              <option value="">+ filter by…</option>
              {addable.map((f) => (
                <option key={f} value={f}>
                  {label(type, f)}
                </option>
              ))}
            </select>
          )}
          {controls.length === 0 && !editable && <span className="text-secondary small">None.</span>}
        </div>
      </div>
      <div className="row mb-2 align-items-baseline" data-help={HELP.pageSources}>
        <div className="col-4 col-xl-3 text-secondary small">
          Sources <Help text={HELP.pageSources} />
        </div>
        <div className="col d-flex flex-column gap-1" data-testid="page-sources">
          {sources.map(([name, s]) => {
            const from = text(s.from);
            return (
              <div key={name} className="d-flex flex-wrap gap-2 align-items-center" data-testid="page-source" data-source={name}>
                <code>{name}</code>
                {isValues(s) ? (
                  <>
                    <span className="text-secondary small">counts</span>
                    <select
                      className="form-select form-select-sm w-auto"
                      value={from}
                      disabled={!editable}
                      onChange={(e) => {
                        const field = distinctOf(e.target.value)[0] ?? "@firstSeen";
                        changeSource(name, { from: e.target.value, distinct: field, by: DAY_KINDS.has(kindOf(e.target.value, field)) && isDays(s) ? "day" : undefined });
                      }}
                      aria-label={`${name}: of`}
                      data-testid="page-source-from"
                    >
                      {!Object.hasOwn(app.types, from) && <option value={from}>{from}</option>}
                      {Object.keys(app.types).map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                    <select
                      className="form-select form-select-sm w-auto"
                      value={text(s.distinct)}
                      disabled={!editable}
                      onChange={(e) => changeSource(name, { distinct: e.target.value, by: DAY_KINDS.has(kindOf(from, e.target.value)) && isDays(s) ? "day" : undefined })}
                      aria-label={`${name}: the values of`}
                      data-testid="page-source-field"
                    >
                      {!distinctOf(from).includes(text(s.distinct)) && <option value={text(s.distinct)}>{text(s.distinct)}</option>}
                      {distinctOf(from).map((f) => (
                        <option key={f} value={f}>
                          {label(from, f)}
                        </option>
                      ))}
                    </select>
                    {DAY_KINDS.has(kindOf(from, text(s.distinct))) && (
                      <label className="form-check form-check-inline mb-0 me-0">
                        <input
                          type="checkbox"
                          className="form-check-input"
                          checked={isDays(s)}
                          disabled={!editable}
                          onChange={(e) => changeSource(name, { by: e.target.checked ? "day" : undefined })}
                          aria-label={`${name}: by day`}
                          data-testid="page-source-days"
                        />
                        <span className="form-check-label small">by day</span>
                      </label>
                    )}
                  </>
                ) : (
                  <span className="text-secondary small">entities of {from} (written in the YAML)</span>
                )}
                {editable && (
                  <button type="button" className="btn btn-ghost-danger btn-icon btn-sm" aria-label={`Remove the source ${name}`} onClick={() => removeSource(name)}>
                    <IconTrash size={16} />
                  </button>
                )}
              </div>
            );
          })}
          {editable && sources.length < 6 && (
            <select
              className="form-select form-select-sm w-auto"
              value=""
              onChange={(e) => e.target.value && addSource(e.target.value)}
              aria-label="Add a source"
              data-testid="page-sources-add"
            >
              <option value="">+ count the values of…</option>
              {distinctOf(type).map((f) => (
                <option key={f} value={f}>
                  {label(type, f)}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
    </>
  );
}

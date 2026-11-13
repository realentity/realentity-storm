import {
  fieldLabel,
  listPageOf,
  moveListPage,
  removePage,
  setPageProperty,
  viewPageOf,
  VIEW_ICONS,
  type AppDefinition,
  type AppIssue,
  type PageKind,
} from "@realentity/storm-shared";
import {
  IconArrowDown,
  IconArrowLeft,
  IconArrowRight,
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconPlus,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { asObject, text, type LooseApp } from "../lib/loose-app";
import { HELP } from "../lib/help";
import { Issues } from "./AppIssues";
import { Help } from "./Help";
import { type TableDesign } from "./ListTable";
import { PagePreview } from "./PagePreview";
import { CommitInput, type DesignerEdit } from "./TypesDesigner";

/**
 * M37-T1: the App's pages, a type at a time: its list (in the menu), its own page, and its form when it has fields of
 * mine. A page not written yet is shown as its default from the type's fields; the first change writes it out.
 */
export function PagesDesigner({
  source,
  appId,
  app,
  definition,
  issues,
  onLine,
  onEdit,
  editable,
}: Readonly<{
  /** The App's YAML and the App it is a draft of: the preview draws the pages from them. */
  source: string;
  appId?: string;
  app: LooseApp;
  /** The App as compiled; null while it has problems the pages can't be drawn with. */
  definition: AppDefinition | null;
  issues: AppIssue[];
  onLine: (line: number) => void;
  onEdit: (edit: DesignerEdit) => void;
  editable: boolean;
}>) {
  const listOrder = app.pages.flatMap((p) => (typeof p.list === "string" ? [p.list] : []));
  const types = definition ? Object.keys(definition.types) : [];
  // The list pages in the menu's order: the written ones first, as they are; then the defaults.
  const ordered = [...listOrder.filter((t) => types.includes(t)), ...types.filter((t) => !listOrder.includes(t))];
  return (
    <div className="card-body d-flex flex-column gap-4" data-testid="pages-tab">
      <Issues issues={issues.filter((i) => !/^pages\.\d+/.test(i.path))} onLine={onLine} />
      {!definition && (
        <div className="alert alert-warning mb-0">The App has problems on its other tabs: its pages show once they are fixed.</div>
      )}
      {definition && (
        <div className="text-secondary">
          Each type has a list page in the menu and a page of its own. Until you change one it shows its type&apos;s fields as they are; a
          change writes it into the YAML.
        </div>
      )}
      {definition &&
        ordered.map((type, i) => (
          <TypePages
            key={type}
            type={type}
            source={source}
            appId={appId}
            app={app}
            definition={definition}
            issues={issues}
            onLine={onLine}
            onEdit={onEdit}
            editable={editable}
            move={{
              up: i > 0 && listOrder.includes(type) ? () => onEdit((s) => moveListPage(s, type, -1)) : undefined,
              down: i < listOrder.length - 1 && listOrder.includes(type) ? () => onEdit((s) => moveListPage(s, type, 1)) : undefined,
            }}
          />
        ))}
    </div>
  );
}

/** A button inside a chip: no button box around it. */
const CHIP_BUTTON = "border-0 bg-transparent p-0 lh-1 text-reset d-inline-flex";

interface Option {
  name: string;
  label: string;
}

/** One field's value, as a `when` or an `unless` holds it: { status: paid }. */
interface Condition {
  field: string;
  value: string | boolean;
  label: string;
}

const conditionKey = (c: { field: string; value: unknown }) => `${c.field}=${text(c.value)}`;

/** The one condition a `when` holds, as the designer writes it; anything else isn't picked here. */
function conditionOf(when: unknown): string {
  const entries = Object.entries(asObject(when));
  return entries.length === 1 ? conditionKey({ field: entries[0][0], value: entries[0][1] }) : "";
}

function TypePages({
  type,
  source,
  appId,
  app,
  definition,
  issues,
  onLine,
  onEdit,
  editable,
  move,
}: Readonly<{
  type: string;
  source: string;
  appId?: string;
  app: LooseApp;
  definition: AppDefinition;
  issues: AppIssue[];
  onLine: (line: number) => void;
  onEdit: (edit: DesignerEdit) => void;
  editable: boolean;
  move: { up?: () => void; down?: () => void };
}>) {
  const def = definition.types[type];
  const fields = Object.entries(def.fields);
  const option = (name: string): Option => ({ name, label: fieldLabel(def, name) });
  const all = fields.map(([name]) => option(name));
  const seen = [option("@firstSeen"), option("@lastSeen")];
  const of = (...kinds: string[]) => fields.filter(([, f]) => kinds.includes(f.type)).map(([name]) => option(name));
  const written = (kind: PageKind) => {
    const index = app.pages.findIndex((p) => p[kind] === type);
    return index < 0 ? null : { index, raw: app.pages[index] };
  };
  const set = (kind: PageKind, property: string, value: unknown) => onEdit((s) => setPageProperty(s, kind, type, property, value));
  const list = listPageOf(definition, type);
  const view = viewPageOf(definition, type);
  const listPage = written("list");
  const viewPage = written("view");
  const formPage = written("form");
  const rawList = listPage?.raw ?? {};
  const rawView = viewPage?.raw ?? {};
  // M45: any field but the stage, and the key unless the type is mine (it names the entity and stays).
  const formFields = fields.filter(([name]) => (def.mine || name !== def.key) && def.stages?.field !== name).map(([n]) => option(n));

  // A column or total written as a map (a label, a due badge, a when) stays one when it's moved.
  const keepWritten = (raw: unknown, names: string[]) => {
    const items: unknown[] = Array.isArray(raw) ? raw : [];
    const byField = new Map(items.map((c) => [text(asObject(c).field ?? c), c]));
    return names.map((name): unknown => byField.get(name) ?? name);
  };
  // The menu's label and icon; both left empty: the defaults (the type's name, the App's icon).
  const menuWith = (patch: Record<string, string>) => {
    const next: Record<string, unknown> = { ...asObject(rawList.menu), ...patch };
    for (const key of Object.keys(next)) if (!next[key]) delete next[key];
    return Object.keys(next).length ? next : undefined;
  };
  const group = asObject(rawList.group);
  const groupBy = list.group?.by.field ?? "";
  const dateKinds = new Set(["date", "datetime"]);
  const setGroup = (patch: Record<string, unknown>) => {
    const next = { ...group, ...patch };
    for (const key of Object.keys(next))
      if (next[key] === undefined || (Array.isArray(next[key]) && (next[key] as unknown[]).length === 0)) delete next[key];
    set("list", "group", next.by ? next : undefined);
  };
  // The columns as they are written, else as the default gives them: a due badge is set on one of them.
  const rawColumns: unknown[] = Array.isArray(rawList.columns) ? rawList.columns : list.columns.map((c) => c.field);
  const dates = list.columns.filter((c) => dateKinds.has(def.fields[c.field]?.type ?? "")).map((c) => option(c.field));
  // What a badge or a total may be "only when": a value of an enum or yes/no field.
  const conditions: Condition[] = fields.flatMap(([name, f]): Condition[] => {
    if (f.type === "enum") return (f.values ?? []).map((value) => ({ field: name, value, label: `${fieldLabel(def, name)} is ${value}` }));
    if (f.type === "yesno")
      return [true, false].map((value) => ({ field: name, value, label: `${fieldLabel(def, name)} is ${value ? "yes" : "no"}` }));
    return [];
  });
  const sections = Array.isArray(rawView.sections) ? rawView.sections.map(asObject) : null;
  const [previewing, setPreviewing] = useState(true);
  // What is done on the preview's headings, written as the controls above write it.
  const textKinds = new Set(["text", "longtext", "enum", "email", "url"]);
  const design: TableDesign = {
    onMove: (from, to) => {
      const names = list.columns.map((c) => c.field);
      const [moved] = names.splice(from, 1);
      names.splice(to, 0, moved);
      set("list", "columns", keepWritten(rawColumns, names));
    },
    onSort: (field) => {
      const desc = list.sort.by === field ? !list.sort.desc : !textKinds.has(def.fields[field]?.type ?? "");
      set("list", "sort", `${desc ? "-" : ""}${field}`);
    },
    onGroup: (field) => {
      if (!field) set("list", "group", undefined);
      else setGroup({ by: field, period: dateKinds.has(def.fields[field]?.type ?? "") || field.startsWith("@") ? "month" : undefined });
    },
  };
  const pageIssues = (page: { index: number } | null) =>
    page ? issues.filter((i) => i.path === `pages.${page.index}` || i.path.startsWith(`pages.${page.index}.`)) : [];

  return (
    <div className="border rounded" data-testid="type-pages" data-type={type}>
      <div className="d-flex align-items-center gap-2 px-3 py-2 border-bottom bg-body-tertiary">
        <h3 className="mb-0">{type}</h3>
        <span className="text-secondary small">{fields.length} fields</span>
        <div className="ms-auto btn-list">
          <button
            type="button"
            className="btn btn-sm btn-icon"
            disabled={!editable || !move.up}
            onClick={move.up}
            title="Up in the menu"
            aria-label={`${type} up in the menu`}
          >
            <IconArrowUp size={16} />
          </button>
          <button
            type="button"
            className="btn btn-sm btn-icon"
            disabled={!editable || !move.down}
            onClick={move.down}
            title="Down in the menu"
            aria-label={`${type} down in the menu`}
          >
            <IconArrowDown size={16} />
          </button>
        </div>
      </div>
      <div className="row g-0">
        <div className="col-lg-6 p-3 border-end" data-testid="page-list">
          <PageHead
            title="List page"
            written={listPage !== null}
            onDefault={() => onEdit((s) => removePage(s, "list", type))}
            editable={editable}
          />
          <Issues issues={pageIssues(listPage)} onLine={onLine} />
          <Row label="In the menu" help={HELP.pageMenu}>
            <div className="d-flex gap-2 align-items-center flex-wrap">
              <label className="form-check form-switch mb-0">
                <input
                  type="checkbox"
                  className="form-check-input"
                  checked={list.menu}
                  disabled={!editable}
                  onChange={(e) => set("list", "menu", e.target.checked ? undefined : false)}
                  data-testid="page-menu"
                />
              </label>
              {list.menu && (
                <>
                  <CommitInput
                    value={list.label}
                    className="form-control form-control-sm w-auto"
                    disabled={!editable}
                    onCommit={(label) => set("list", "menu", menuWith({ label }))}
                    ariaLabel={`${type}'s name in the menu`}
                    testId="page-menu-label"
                  />
                  <select
                    className="form-select form-select-sm w-auto"
                    value={text(asObject(rawList.menu).icon)}
                    disabled={!editable}
                    onChange={(e) => set("list", "menu", menuWith({ icon: e.target.value }))}
                    aria-label={`${type}'s icon in the menu`}
                  >
                    <option value="">the App&apos;s icon</option>
                    {VIEW_ICONS.map((i) => (
                      <option key={i} value={i}>
                        {i}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
          </Row>
          <Row label="Columns" help={HELP.pageColumns}>
            <FieldChips
              value={list.columns.map((c) => c.field)}
              options={[...all, ...seen]}
              max={8}
              editable={editable}
              onChange={(names) => set("list", "columns", keepWritten(rawList.columns, names))}
              testId="page-columns"
            />
          </Row>
          {dates.length > 0 && (
            <Row label="Due badge" help={HELP.pageDue}>
              <DueBadge
                dates={dates}
                columns={rawColumns}
                conditions={conditions}
                editable={editable}
                onChange={(columns) => set("list", "columns", columns)}
              />
            </Row>
          )}
          <Row label="Filters" help={HELP.pageFilters}>
            <Checks
              options={of("enum", "yesno")}
              value={list.filters.map((f) => f.field)}
              editable={editable}
              onChange={(names) => set("list", "filters", names)}
              none="No choice or yes/no fields to filter by."
              testId="page-filters"
            />
          </Row>
          <Row label="Search in" help={HELP.pageSearch}>
            <Checks
              options={of("text", "longtext", "enum", "email", "url")}
              value={list.search}
              editable={editable}
              onChange={(names) => set("list", "search", names.length ? names : undefined)}
              none="No text fields to search."
              testId="page-search"
            />
          </Row>
          <Row label="Sorted by" help={HELP.pageSort}>
            <div className="d-flex gap-2">
              <select
                className="form-select form-select-sm w-auto"
                value={list.sort.by}
                disabled={!editable}
                onChange={(e) => set("list", "sort", `${list.sort.desc ? "-" : ""}${e.target.value}`)}
                aria-label="Sorted by"
                data-testid="page-sort"
              >
                {[...all, ...seen].map((o) => (
                  <option key={o.name} value={o.name}>
                    {o.label}
                  </option>
                ))}
              </select>
              <select
                className="form-select form-select-sm w-auto"
                value={list.sort.desc ? "desc" : "asc"}
                disabled={!editable}
                onChange={(e) => set("list", "sort", `${e.target.value === "desc" ? "-" : ""}${list.sort.by}`)}
                aria-label="Order"
                data-testid="page-sort-order"
              >
                <option value="desc">highest, newest first</option>
                <option value="asc">lowest, oldest first</option>
              </select>
            </div>
          </Row>
          <Row label="In groups by" help={HELP.pageGroup}>
            <div className="d-flex flex-column gap-2">
              <div className="d-flex gap-2">
                <select
                  className="form-select form-select-sm w-auto"
                  value={groupBy}
                  disabled={!editable}
                  onChange={(e) => setGroup({ by: e.target.value || undefined, period: undefined })}
                  aria-label="In groups by"
                  data-testid="page-group"
                >
                  <option value="">no groups</option>
                  {[...all, ...seen].map((o) => (
                    <option key={o.name} value={o.name}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {groupBy && (dateKinds.has(def.fields[groupBy]?.type ?? "") || groupBy.startsWith("@")) && (
                  <select
                    className="form-select form-select-sm w-auto"
                    value={text(group.period)}
                    disabled={!editable}
                    onChange={(e) => setGroup({ period: e.target.value || undefined })}
                    aria-label="Group by its"
                    data-testid="page-group-period"
                  >
                    <option value="">its date</option>
                    <option value="month">month</option>
                    <option value="year">year</option>
                  </select>
                )}
              </div>
              {groupBy && (
                <div className="d-flex gap-2 align-items-baseline">
                  <span className="text-secondary small">Totals:</span>
                  <Checks
                    options={of("number", "money")}
                    value={(Array.isArray(group.totals) ? group.totals : []).filter((t) => typeof t === "string").map(text)}
                    editable={editable}
                    onChange={(names) => {
                      // Totals with a label or a when are kept as written.
                      const totals: unknown[] = Array.isArray(group.totals) ? group.totals : [];
                      const special = totals.filter((t) => typeof t !== "string");
                      setGroup({ totals: [...names, ...special] });
                    }}
                    none="No number or money fields to sum."
                    testId="page-totals"
                  />
                </div>
              )}
              {groupBy && of("number", "money").length > 0 && conditions.length > 0 && (
                <WhenTotals
                  totals={Array.isArray(group.totals) ? (group.totals as unknown[]) : []}
                  numbers={of("number", "money")}
                  conditions={conditions}
                  editable={editable}
                  onChange={(totals) => setGroup({ totals })}
                />
              )}
            </div>
          </Row>
          {def.stages && (
            <Row label="Stage buttons" help={HELP.pageMoves}>
              <label className="form-check mb-0">
                <input
                  type="checkbox"
                  className="form-check-input"
                  checked={list.moves !== null}
                  disabled={!editable}
                  onChange={(e) => set("list", "moves", e.target.checked || undefined)}
                  data-testid="page-moves"
                />
                <span className="form-check-label">a button on each row for each move you can make</span>
              </label>
            </Row>
          )}
          {!def.mine && (
            <Row label="Added by hand" help={HELP.pageAdd}>
              <label className="form-check mb-0">
                <input
                  type="checkbox"
                  className="form-check-input"
                  checked={list.create !== null}
                  disabled={!editable}
                  onChange={(e) => set("list", "add", e.target.checked || undefined)}
                  data-testid="page-add"
                />
                <span className="form-check-label">New on the list, Delete on its page</span>
              </label>
            </Row>
          )}
          <Row label="Removed tab" help={HELP.pageRemoved}>
            <label className="form-check mb-0">
              <input
                type="checkbox"
                className="form-check-input"
                checked={list.removed}
                disabled={!editable}
                onChange={(e) => set("list", "removed", e.target.checked || undefined)}
                data-testid="page-removed"
              />
              <span className="form-check-label">the ones a pipeline no longer found</span>
            </label>
          </Row>
        </div>
        <div className="col-lg-6 p-3" data-testid="page-view">
          <PageHead
            title="Its own page"
            written={viewPage !== null}
            onDefault={() => onEdit((s) => removePage(s, "view", type))}
            editable={editable}
          />
          <Issues issues={pageIssues(viewPage)} onLine={onLine} />
          {sections ? (
            <>
              {sections.map((section, i) => (
                <div key={i} className="mb-3" data-testid="page-section" data-help={HELP.pageSection}>
                  <div className="d-flex gap-2 mb-1">
                    <CommitInput
                      value={text(section.title)}
                      className="form-control form-control-sm fw-bold"
                      disabled={!editable}
                      valid={(v) => v.length > 0}
                      onCommit={(title) =>
                        set(
                          "view",
                          "sections",
                          sections.map((s, j) => (j === i ? { ...s, title } : s)),
                        )
                      }
                      ariaLabel="Section title"
                      testId="page-section-title"
                    />
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost-danger btn-icon"
                      disabled={!editable}
                      title="Remove the section"
                      aria-label={`Remove the section ${text(section.title)}`}
                      onClick={() =>
                        set(
                          "view",
                          sections.length > 1 ? "sections" : "fields",
                          sections.length > 1 ? sections.filter((_, j) => j !== i) : section.fields,
                        )
                      }
                    >
                      <IconTrash size={16} />
                    </button>
                  </div>
                  <FieldChips
                    value={(Array.isArray(section.fields) ? section.fields : []).map(text)}
                    options={[...all, ...seen]}
                    max={40}
                    min={1}
                    editable={editable}
                    onChange={(names) =>
                      set(
                        "view",
                        "sections",
                        sections.map((s, j) => (j === i ? { ...s, fields: names } : s)),
                      )
                    }
                    testId="page-section-fields"
                  />
                </div>
              ))}
              <button
                type="button"
                className="btn btn-sm"
                disabled={!editable || sections.length >= 6}
                onClick={() => set("view", "sections", [...sections, { title: `Section ${sections.length + 1}`, fields: [all[0].name] }])}
                data-testid="add-section"
              >
                <IconPlus size={16} className="me-1" />
                Add a section
              </button>
            </>
          ) : (
            <>
              <Row label="Fields" help={HELP.pageViewFields}>
                <FieldChips
                  value={view.sections[0]?.fields.map((f) => f.field) ?? []}
                  options={[...all, ...seen]}
                  max={40}
                  min={1}
                  editable={editable}
                  onChange={(names) => set("view", "fields", names)}
                  testId="page-view-fields"
                />
              </Row>
              <button
                type="button"
                className="btn btn-sm"
                disabled={!editable}
                onClick={() =>
                  set("view", "sections", [{ title: type, fields: view.sections[0]?.fields.map((f) => f.field) ?? [all[0].name] }])
                }
                data-testid="add-section"
              >
                <IconPlus size={16} className="me-1" />
                Split into sections
              </button>
            </>
          )}
          {formFields.length > 0 && (
            <div className="mt-4" data-testid="page-form">
              <PageHead
                title="Its form"
                written={formPage !== null}
                onDefault={() => onEdit((s) => removePage(s, "form", type))}
                editable={editable}
              />
              <Issues issues={pageIssues(formPage)} onLine={onLine} />
              <Row label="Fields you fill in" help={HELP.pageFormFields}>
                <FieldChips
                  value={view.form.map((f) => f.field)}
                  options={formFields}
                  max={40}
                  min={1}
                  editable={editable}
                  onChange={(names) => set("form", "fields", names)}
                  testId="page-form-fields"
                />
              </Row>
            </div>
          )}
        </div>
      </div>
      <div className="border-top">
        <button
          type="button"
          className="btn btn-ghost-secondary w-100 rounded-0 justify-content-start"
          onClick={() => setPreviewing(!previewing)}
          aria-expanded={previewing}
          data-testid="toggle-preview"
        >
          {previewing ? <IconChevronDown size={16} className="me-1" /> : <IconChevronRight size={16} className="me-1" />}
          Preview
        </button>
        {previewing && (
          <div className="p-3 pt-0">
            <PagePreview source={source} appId={appId} type={type} design={design} />
          </div>
        )}
      </div>
    </div>
  );
}

function PageHead({
  title,
  written,
  onDefault,
  editable,
}: Readonly<{ title: string; written: boolean; onDefault: () => void; editable: boolean }>) {
  return (
    <div className="d-flex align-items-center gap-2 mb-2">
      <h4 className="mb-0">{title}</h4>
      {written ? (
        <button
          type="button"
          className="btn btn-sm btn-ghost-secondary ms-auto"
          disabled={!editable}
          onClick={onDefault}
          data-testid="page-default"
        >
          Back to the default
        </button>
      ) : (
        <span className="badge bg-secondary-lt ms-auto" data-testid="page-is-default">
          default
        </span>
      )}
    </div>
  );
}

/** A labelled row of a page's controls; its info icon says what they set (M38-T3). */
function Row({ label, help, children }: Readonly<{ label: string; help: string; children: ReactNode }>) {
  return (
    <div className="row mb-2 align-items-baseline" data-help={help}>
      <div className="col-4 col-xl-3 text-secondary small">
        {label} <Help text={help} />
      </div>
      <div className="col">{children}</div>
    </div>
  );
}

/** Fields in order: each moved left or right, removed; one added from the rest. */
function FieldChips({
  value,
  options,
  max,
  min = 1,
  editable,
  onChange,
  testId,
}: Readonly<{
  value: string[];
  options: Option[];
  max: number;
  min?: number;
  editable: boolean;
  onChange: (names: string[]) => void;
  testId: string;
}>) {
  const label = (name: string) => options.find((o) => o.name === name)?.label ?? name;
  const rest = options.filter((o) => !value.includes(o.name));
  const moved = (i: number, delta: number) => {
    const next = [...value];
    [next[i], next[i + delta]] = [next[i + delta], next[i]];
    onChange(next);
  };
  return (
    <div className="d-flex flex-wrap gap-1 align-items-center" data-testid={testId}>
      {value.map((name, i) => (
        <span key={name} className="badge bg-blue-lt d-inline-flex align-items-center gap-1" data-testid="chip" data-field={name}>
          {editable && i > 0 && (
            <button type="button" className={CHIP_BUTTON} onClick={() => moved(i, -1)} aria-label={`${label(name)} earlier`}>
              <IconArrowLeft size={12} />
            </button>
          )}
          {label(name)}
          {editable && i < value.length - 1 && (
            <button type="button" className={CHIP_BUTTON} onClick={() => moved(i, 1)} aria-label={`${label(name)} later`}>
              <IconArrowRight size={12} />
            </button>
          )}
          {editable && value.length > min && (
            <button
              type="button"
              className={CHIP_BUTTON}
              onClick={() => onChange(value.filter((v) => v !== name))}
              aria-label={`Remove ${label(name)}`}
            >
              <IconX size={12} />
            </button>
          )}
        </span>
      ))}
      {editable && rest.length > 0 && value.length < max && (
        <select
          className="form-select form-select-sm w-auto"
          value=""
          onChange={(e) => e.target.value && onChange([...value, e.target.value])}
          aria-label="Add a field"
          data-testid={`${testId}-add`}
        >
          <option value="">+ add</option>
          {rest.map((o) => (
            <option key={o.name} value={o.name}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function Checks({
  options,
  value,
  editable,
  onChange,
  none,
  testId,
}: Readonly<{ options: Option[]; value: string[]; editable: boolean; onChange: (names: string[]) => void; none: string; testId: string }>) {
  if (options.length === 0) return <span className="text-secondary small">{none}</span>;
  return (
    <div className="d-flex flex-wrap gap-3" data-testid={testId}>
      {options.map((o) => (
        <label key={o.name} className="form-check form-check-inline mb-0 me-0">
          <input
            type="checkbox"
            className="form-check-input"
            checked={value.includes(o.name)}
            disabled={!editable}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? options.filter((x) => x.name === o.name || value.includes(x.name)).map((x) => x.name)
                  : value.filter((v) => v !== o.name),
              )
            }
            data-field={o.name}
          />
          <span className="form-check-label">{o.label}</span>
        </label>
      ))}
    </div>
  );
}

/** A date column's badge when it is near, past or today, unless the entity is as a condition says (paid). */
function DueBadge({
  dates,
  columns,
  conditions,
  editable,
  onChange,
}: Readonly<{ dates: Option[]; columns: unknown[]; conditions: Condition[]; editable: boolean; onChange: (columns: unknown[]) => void }>) {
  const fieldOf = (c: unknown) => text(asObject(c).field ?? c);
  const current = columns.find((c) => asObject(c).due !== undefined);
  const due = asObject(asObject(current).due);
  const days = typeof due.days === "number" ? due.days : 3;
  const write = (field: string, patch: { days?: number; unless?: string }) => {
    const unless = conditions.find((c) => conditionKey(c) === (patch.unless ?? conditionOf(due.unless)));
    onChange(
      columns.map((c): unknown => {
        const rest = { ...(typeof c === "string" ? { field: c } : asObject(c)) };
        delete rest.due;
        const plain = Object.keys(rest).length === 1 ? fieldOf(c) : rest;
        if (fieldOf(c) !== field) return plain;
        return { ...rest, due: { days: patch.days ?? days, ...(unless ? { unless: { [unless.field]: unless.value } } : {}) } };
      }),
    );
  };
  return (
    <div className="d-flex gap-2 flex-wrap align-items-center" data-testid="page-due">
      <select
        className="form-select form-select-sm w-auto"
        value={current ? fieldOf(current) : ""}
        disabled={!editable}
        onChange={(e) => write(e.target.value, {})}
        aria-label="Due badge on"
        data-testid="page-due-field"
      >
        <option value="">none</option>
        {dates.map((o) => (
          <option key={o.name} value={o.name}>
            on {o.label}
          </option>
        ))}
      </select>
      {current !== undefined && (
        <>
          <span className="text-secondary small">from</span>
          <div style={{ width: 56 }}>
            <CommitInput
              value={String(days)}
              className="form-control form-control-sm"
              valid={(v) => /^\d{1,2}$/.test(v) && Number(v) <= 60}
              disabled={!editable}
              onCommit={(v) => write(fieldOf(current), { days: Number(v) })}
              ariaLabel="Days before"
              help={HELP.pageDueDays}
              testId="page-due-days"
            />
          </div>
          <span className="text-secondary small">days before, unless</span>
          <select
            className="form-select form-select-sm w-auto"
            value={conditionOf(due.unless)}
            disabled={!editable}
            onChange={(e) => write(fieldOf(current), { unless: e.target.value })}
            aria-label="Unless"
            data-testid="page-due-unless"
          >
            <option value="">always shown</option>
            {conditions.map((c) => (
              <option key={conditionKey(c)} value={conditionKey(c)}>
                {c.label}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}

/** Totals of only some of a group's entities: "Unpaid: amount, when status is due". */
function WhenTotals({
  totals,
  numbers,
  conditions,
  editable,
  onChange,
}: Readonly<{ totals: unknown[]; numbers: Option[]; conditions: Condition[]; editable: boolean; onChange: (totals: unknown[]) => void }>) {
  const [field, setField] = useState(numbers[0].name);
  const [label, setLabel] = useState("");
  const [when, setWhen] = useState("");
  const special = totals.map((t, index) => ({ t: asObject(t), index })).filter(({ t }) => t.field !== undefined);
  const condition = conditions.find((c) => conditionKey(c) === when);
  return (
    <div className="d-flex flex-column gap-1" data-testid="page-when-totals">
      {special.map(({ t, index }) => (
        <span
          key={index}
          className="badge bg-blue-lt align-self-start d-inline-flex gap-1 align-items-center py-1"
          data-testid="when-total"
        >
          {text(t.label) || text(t.field)}: {text(t.field)}
          {t.when !== undefined && <> when {conditions.find((c) => conditionKey(c) === conditionOf(t.when))?.label ?? text(t.when)}</>}
          {editable && (
            <button
              type="button"
              className={CHIP_BUTTON}
              onClick={() => onChange(totals.filter((_, i) => i !== index))}
              aria-label={`Remove the total ${text(t.label)}`}
            >
              <IconX size={12} />
            </button>
          )}
        </span>
      ))}
      {editable && (
        <div className="d-flex gap-2 align-items-center flex-wrap">
          <span className="text-secondary small">A total of</span>
          <select
            className="form-select form-select-sm w-auto"
            value={field}
            onChange={(e) => setField(e.target.value)}
            aria-label="A total of"
            data-testid="when-total-field"
          >
            {numbers.map((o) => (
              <option key={o.name} value={o.name}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            className="form-select form-select-sm w-auto"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            aria-label="Only when"
            data-testid="when-total-when"
          >
            <option value="">only when…</option>
            {conditions.map((c) => (
              <option key={conditionKey(c)} value={conditionKey(c)}>
                {c.label}
              </option>
            ))}
          </select>
          <input
            className="form-control form-control-sm w-auto"
            placeholder="called"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-label="The total's name"
            data-testid="when-total-label"
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={!condition || totals.length >= 4}
            onClick={() => {
              if (!condition) return;
              onChange([
                ...totals,
                { field, ...(label.trim() ? { label: label.trim() } : {}), when: { [condition.field]: condition.value } },
              ]);
              setLabel("");
              setWhen("");
            }}
            data-testid="when-total-add"
          >
            <IconPlus size={16} className="me-1" />
            Add
          </button>
        </div>
      )}
    </div>
  );
}

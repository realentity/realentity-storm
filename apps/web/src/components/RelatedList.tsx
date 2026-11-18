import { fieldOf, type PageRelated, type ViewRow } from "@realentity/storm-shared";
import { IconPlus } from "@tabler/icons-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "react-toastify";
import { api } from "../lib/endpoints";
import { useAction, useLoad } from "../lib/use-load";
import { asText } from "../lib/view";
import { EntityForm } from "./EntityForm";
import { ErrorAlert, Loading, Modal } from "./ui";
import { ViewValue } from "./ViewParts";

type Adding = { label: string; set: Record<string, string> };

/**
 * M55: on an entity's page, the entities pointing at it (their ref field `by` holds its key): a table with its own
 * filters, each row opening its page; Add opens their form with `by` set to this one, and kept. M56: an Add button
 * each (Add variable, Add secret) setting fields of the form; rows in groups (a project's paths), each with its Adds;
 * an add takes the filters chosen and its group.
 */
export function RelatedList({
  appId,
  related,
  of,
  changes = 0,
  onAdded,
}: Readonly<{
  appId: string;
  related: PageRelated;
  of: string;
  /** M56: bumped when another list on the page adds one (a path: the groups by path load again). */
  changes?: number;
  onAdded?: () => void;
}>) {
  const [filter, setFilter] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState<Adding | null>(null);
  const action = useAction();
  const list = useLoad(
    () => api.apps.page(appId, related.type, { limit: 200, filter: JSON.stringify({ ...filter, [related.by]: of }) }),
    [appId, related.type, related.by, of, JSON.stringify(filter), changes],
  );
  const group = related.group;
  // A ref's groups: its type's entities (matching this one when they match by `by`), by title.
  const groupRows = useLoad(
    () =>
      group?.ref
        ? api.apps.page(appId, group.ref, { limit: 200, filter: group.match ? JSON.stringify({ [group.match]: of }) : undefined })
        : Promise.resolve(null),
    [appId, group?.ref, group?.match, of, changes],
  );
  const add = async (values: Record<string, unknown>) => {
    const added = await action.run(() => api.apps.add(appId, related.type, { ...values, [related.by]: of }));
    if (!added) return;
    toast.success(`${adding?.label.replace(/^Add\s+/i, "") || related.type} added`);
    setAdding(null);
    list.reload();
    onAdded?.();
  };
  // What an add sets: its button's fields, the filters chosen, its group; the page's entity always.
  const fixedFor = (preset: Adding, groupValue?: string) => {
    const onForm = new Set((related.create ?? []).map((f) => f.field));
    const fixed: Record<string, string> = { ...preset.set };
    for (const [field, value] of Object.entries(filter)) if (onForm.has(field)) fixed[field] = value;
    if (group && groupValue !== undefined && onForm.has(group.field)) fixed[group.field] = groupValue;
    return { ...fixed, [related.by]: of };
  };
  const buttons = (groupValue?: string, small = true) =>
    related.create
      ? related.adds.map((preset) => (
          <button
            key={preset.label}
            type="button"
            className={`btn ${small ? "btn-sm" : ""} ${groupValue === undefined ? "btn-primary" : "btn-outline-primary"} text-nowrap`}
            onClick={() => setAdding({ label: preset.label, set: fixedFor(preset, groupValue) })}
            data-testid={`related-add-${related.type}`}
            data-group={groupValue}
          >
            <IconPlus size={16} className="me-1" />
            {preset.label}
          </button>
        ))
      : null;

  const rows = list.data?.rows ?? [];
  const groups: { value: string | null; label: string }[] | null = group
    ? [
        ...(group.values
          ? group.values.map((v) => ({ value: v, label: v }))
          : (groupRows.data?.rows ?? [])
              .map((r) => ({ value: r.key, label: asText(fieldOf(r, groupRows.data!.page.title) ?? r.key) }))
              .sort((a, b) => a.label.localeCompare(b.label))),
      ]
    : null;
  // Rows whose group isn't one of them (none, or one that went) after the others.
  if (groups && rows.some((r) => !groups.some((g) => g.value === asText(fieldOf(r, group!.field)))))
    groups.push({ value: null, label: `No ${group!.label.toLowerCase()}` });
  const inGroup = (value: string | null) =>
    rows.filter((r) => {
      const v = asText(fieldOf(r, group!.field));
      return value === null ? !groups!.some((g) => g.value !== null && g.value === v) : v === value;
    });

  return (
    <div className="card" data-testid={`related-${related.type}`}>
      <div className="card-header">
        <h3 className="card-title">
          {related.label}
          {list.data && <span className="text-secondary ms-2">{list.data.total}</span>}
        </h3>
        <div className="card-actions d-flex gap-2">
          {related.filters.map((f) => (
            <select
              key={f.field}
              className="form-select form-select-sm"
              aria-label={f.label}
              value={filter[f.field] ?? ""}
              onChange={(e) => setFilter(({ [f.field]: _, ...rest }) => (e.target.value ? { ...rest, [f.field]: e.target.value } : rest))}
              data-testid={`related-filter-${f.field}`}
            >
              <option value="">{f.label}: all</option>
              {f.values.map((v) => (
                <option key={v.value} value={v.value}>
                  {v.label}
                </option>
              ))}
            </select>
          ))}
          {!groups && buttons()}
        </div>
      </div>
      <ErrorAlert error={list.error ?? groupRows.error} />
      {!list.data && list.loading && <Loading />}
      {list.data &&
        !groups &&
        (rows.length === 0 ? (
          <div className="card-body text-secondary">None yet.</div>
        ) : (
          <Rows appId={appId} related={related} rows={rows} />
        ))}
      {list.data && groups && groups.length === 0 && (
        <div className="card-body text-secondary">No {group!.label.toLowerCase()} yet: add one first.</div>
      )}
      {list.data &&
        groups?.map((g) => (
          <div key={g.value ?? ""} className="border-top" data-testid="related-group" data-value={g.value ?? ""}>
            <div className="d-flex flex-wrap align-items-center gap-2 px-3 py-2 bg-body-tertiary">
              <span className="fw-medium me-auto" data-testid="related-group-label">
                {g.label}
                <span className="text-secondary ms-2">{inGroup(g.value).length}</span>
              </span>
              {g.value !== null && buttons(g.value)}
            </div>
            {inGroup(g.value).length === 0 ? (
              <div className="px-3 py-2 text-secondary small">None yet.</div>
            ) : (
              <Rows appId={appId} related={related} rows={inGroup(g.value)} />
            )}
          </div>
        ))}
      {adding && related.create && (
        <Modal title={adding.label === "Add" ? `Add ${related.type}` : adding.label} onClose={() => (setAdding(null), action.clearError())}>
          <ErrorAlert error={action.error} />
          <EntityForm
            fields={related.create}
            values={{}}
            appId={appId}
            fixed={adding.set}
            submit={(values) => void add(values)}
            busy={action.busy}
            label="Add"
            testId="related-form"
          />
        </Modal>
      )}
    </div>
  );
}

function Rows({ appId, related, rows }: Readonly<{ appId: string; related: PageRelated; rows: ViewRow[] }>) {
  const columns = related.columns.filter((c) => c.field !== related.title && c.field !== related.group?.field);
  return (
    <div className="table-responsive">
      <table className="table table-vcenter card-table">
        <thead>
          <tr>
            <th>{related.title}</th>
            {columns.map((c) => (
              <th key={c.field}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} data-testid="related-row">
              <td>
                <Link to={`/a/${appId}/${encodeURIComponent(related.type)}/${encodeURIComponent(row.key)}`}>
                  {asText(fieldOf(row, related.title) ?? row.key)}
                </Link>
              </td>
              {columns.map((c) => (
                <td key={c.field}>
                  <ViewValue row={row} column={c} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

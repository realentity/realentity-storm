import { actionApplies, entityValueAt, fieldOf, groupValue, type EntityGroup, type ViewRow } from "@ai-me/shared";
import { Fragment, useState } from "react";
import { IconPlus } from "@tabler/icons-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Empty, ErrorAlert, Loading, Modal, PageHeader } from "../components/ui";
import { EntityButtons } from "../components/EntityButtons";
import { EntityForm } from "../components/EntityForm";
import { EntityLink } from "../components/EntityLink";
import { SeriesChart } from "../components/SeriesChart";
import { ViewValue } from "../components/ViewParts";
import { api } from "../lib/endpoints";
import { useAction, useLoad } from "../lib/use-load";
import { asText } from "../lib/view";

const PAGE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const NUMBER = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });

/** M31: a type's list, as its App's page says: tabs, filters, search, groups with totals, and its entities. */
export function AppListPage() {
  const { appId = "", type = "" } = useParams();
  const [tab, setTab] = useState<"current" | "removed">("current");
  const [filter, setFilter] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [q, setQ] = useState<string>();
  const [offset, setOffset] = useState(0);
  const [adding, setAdding] = useState(false);
  const adder = useAction();
  const mover = useAction();
  const navigate = useNavigate();
  const list = useLoad(
    () =>
      api.apps.page(appId, type, { tab, q, offset, limit: PAGE, filter: Object.keys(filter).length ? JSON.stringify(filter) : undefined }),
    [appId, type, tab, q, offset, JSON.stringify(filter)],
    (signal) => signal.type === "run" && (signal.status === "DONE" || signal.status === "FAILED"),
  );
  // Another list: start over.
  const [shown, setShown] = useState(`${appId}/${type}`);
  if (shown !== `${appId}/${type}`) {
    setShown(`${appId}/${type}`);
    setTab("current");
    setFilter({});
    setSearch("");
    setQ(undefined);
    setOffset(0);
  }
  if (!list.data) return list.error ? <ErrorAlert error={list.error} /> : <Loading />;
  const { page, rows, total, counts, groups } = list.data;
  const pick = (field: string, value: string) => {
    const next = { ...filter };
    if (value) next[field] = value;
    else delete next[field];
    setFilter(next);
    setOffset(0);
  };

  return (
    <>
      <PageHeader
        pretitle={<Link to={`/apps/${appId}`}>{list.data.app}</Link>}
        title={page.label}
        actions={
          <>
            <EntityButtons appId={appId} type={type} actions={page.actions.map((a, index) => ({ index, ...a }))} />
            {page.create && (
              <button type="button" className="btn btn-primary" onClick={() => setAdding(true)} data-testid="add-entity">
                <IconPlus size={18} className="me-1" />
                New {type}
              </button>
            )}
          </>
        }
      />
      {adding && page.create && (
        <Modal title={`New ${type}`} onClose={() => (setAdding(false), adder.clearError())}>
          <ErrorAlert error={adder.error} />
          <EntityForm
            fields={page.create}
            values={{}}
            busy={adder.busy}
            label="Add"
            testId="add-form"
            submit={(values) =>
              void adder.run(() => api.apps.add(appId, type, values)).then((added) => {
                if (added) void navigate(`/a/${appId}/${encodeURIComponent(type)}/${encodeURIComponent(added.row.key)}`);
              })
            }
          />
        </Modal>
      )}
      {list.data.chart && page.chart && (
        <div className="card mb-3" data-testid="app-chart">
          <div className="card-header">
            <h3 className="card-title">{page.chart.label}</h3>
            {list.data.chart.more > 0 && <span className="card-subtitle ms-2">the top {list.data.chart.series.length}; {list.data.chart.more} more</span>}
          </div>
          <div className="card-body">
            <SeriesChart
              series={list.data.chart.series.map((s) => ({ id: s.key, label: s.label, points: s.points }))}
              stepped={page.chart.stepped}
              label={`${page.chart.label} of ${page.label}`}
              empty="Nothing kept yet."
            />
          </div>
        </div>
      )}
      <div className="card">
        <div className="card-header">
          <ul className="nav nav-tabs card-header-tabs" role="tablist">
            {(["current", ...(page.removed ? ["removed" as const] : [])] as const).map((t) => (
              <li key={t} className="nav-item">
                <button
                  type="button"
                  role="tab"
                  aria-selected={t === tab}
                  className={`nav-link ${t === tab ? "active" : ""}`}
                  onClick={() => (setTab(t), setOffset(0))}
                >
                  {t === "current" ? "Current" : "Removed"}
                  <span className="badge bg-secondary-lt ms-2">{counts[t]}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="card-body border-bottom py-2 d-flex flex-wrap gap-2 align-items-center">
          {page.filters.map((f) => (
            <select
              key={f.field}
              className="form-select form-select-sm w-auto"
              aria-label={f.label}
              value={filter[f.field] ?? ""}
              onChange={(e) => pick(f.field, e.target.value)}
              data-testid={`filter-${f.field}`}
            >
              <option value="">{f.label}: all</option>
              {f.values.map((v) => (
                <option key={v.value} value={v.value}>
                  {f.label}: {v.label}
                </option>
              ))}
            </select>
          ))}
          <form
            className="ms-auto"
            onSubmit={(e) => {
              e.preventDefault();
              setQ(search.trim() || undefined);
              setOffset(0);
            }}
          >
            <input
              className="form-control form-control-sm"
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search"
            />
          </form>
        </div>
        <ErrorAlert error={list.error} />
        {rows.length === 0 ? (
          <Empty>{q || Object.keys(filter).length ? "Nothing matches." : `No ${page.label.toLowerCase()} yet.`}</Empty>
        ) : (
          <div className="table-responsive">
            <table className="table table-vcenter card-table">
              <thead>
                <tr>
                  {page.columns.map((c) => (
                    <th key={c.field}>{c.label}</th>
                  ))}
                  <th className="w-1" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const group = groups && page.group ? groupOf(groups, row, page.group.by.field, page.group.period) : null;
                  const first = group && (i === 0 || groupOf(groups!, rows[i - 1], page.group!.by.field, page.group!.period) !== group);
                  return (
                    <Fragment key={row.key}>
                      {first && (
                        <tr className="bg-secondary-lt" data-testid="entity-group">
                          <td colSpan={page.columns.length + 1}>
                            <strong>{group.label}</strong>
                            <span className="text-secondary ms-2">{group.count}</span>
                            {group.totals.map((t, j) => (
                              <span key={j} className="ms-3 text-secondary" data-testid="group-total">
                                {page.group!.totals[j]?.label}: <strong className="text-reset">{sums(t.sums, page.group!.totals[j]?.as === "money")}</strong>
                              </span>
                            ))}
                          </td>
                        </tr>
                      )}
                      <tr data-testid="entity-row">
                        {page.columns.map((c) => (
                          <td key={c.field}>
                            {c.field === page.title ? (
                              <Link to={`/a/${appId}/${encodeURIComponent(type)}/${encodeURIComponent(row.key)}`}>
                                <ViewValue row={row} column={{ ...c, as: c.as === "link" ? "text" : c.as }} />
                              </Link>
                            ) : (
                              <ViewValue row={row} column={c} />
                            )}
                            {c.due && <DueBadge row={row} field={c.field} due={c.due} />}
                          </td>
                        ))}
                        <td className="text-end text-nowrap">
                          {page.moves &&
                            (page.moves.to[asText(fieldOf(row, page.moves.field))] ?? []).map((to) => (
                              <button
                                key={to}
                                type="button"
                                className="btn btn-sm me-1"
                                disabled={mover.busy}
                                onClick={() => void mover.run(() => api.apps.move(appId, type, row.key, to)).then((moved) => moved && list.reload())}
                                data-testid="row-move"
                              >
                                {to}
                              </button>
                            ))}
                          <EntityLink row={row} field={page.link} />
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {total > PAGE && (
          <div className="card-footer d-flex gap-2 align-items-center">
            <button type="button" className="btn btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
              Previous
            </button>
            <span className="text-secondary small">
              {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
            </span>
            <button type="button" className="btn btn-sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
              Next
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function groupOf(groups: EntityGroup[], row: ViewRow, field: string, period: "month" | "year" | null): EntityGroup | null {
  const value = groupValue(fieldOf(row, field), period);
  return groups.find((g) => g.value === value) ?? null;
}

/** "1250.00 BGN · 300.00 EUR": money as the rows show it. */
/** A date that is near, as a badge (M33): overdue, today, in N days; nothing when the entity is as `unless` says. */
function DueBadge({ row, field, due }: { row: ViewRow; field: string; due: { days: number; unless?: Record<string, string | boolean | string[]> } }) {
  const value = fieldOf(row, field);
  if (typeof value !== "string" || (due.unless && actionApplies({ when: due.unless }, row.value, entityValueAt))) return null;
  // Whole calendar days from today (here) to the date: yesterday is -1, whatever the hour.
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((Date.parse(`${value.slice(0, 10)}T00:00:00Z`) - today) / DAY_MS);
  if (days < 0) return <span className="badge bg-red-lt ms-2" data-testid="due-badge">overdue</span>;
  if (days <= due.days) return <span className="badge bg-yellow-lt ms-2" data-testid="due-badge">{days === 0 ? "today" : `in ${days} d`}</span>;
  return null;
}

function sums(byCurrency: Record<string, number>, money: boolean): string {
  const entries = Object.entries(byCurrency);
  if (entries.length === 0) return "—";
  return entries.map(([currency, sum]) => `${money ? sum.toFixed(2) : NUMBER.format(sum)}${currency ? ` ${currency}` : ""}`).join(" · ");
}

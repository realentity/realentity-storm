import { useState } from "react";
import { IconPlus } from "@tabler/icons-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { AppHeader } from "../components/AppHeader";
import { Empty, ErrorAlert, Loading, Modal } from "../components/ui";
import { EntityButtons } from "../components/EntityButtons";
import { EntityForm } from "../components/EntityForm";
import { FilterControl } from "../components/FilterControls";
import { ListTable } from "../components/ListTable";
import { SeriesChart } from "../components/SeriesChart";
import { api } from "../lib/endpoints";
import { useAction, useLoad } from "../lib/use-load";

const PAGE = 50;
/** M65: a filter's values in the link: ?f.tags=home&f.tags=work&f.due=2026-11-25. */
const FILTER_PARAM = "f.";

/** M65: what the list shows, as its link says (a link opens it filtered, searched, on its tab and page). */
function listState(params: URLSearchParams) {
  const filter: Record<string, string[]> = {};
  for (const [name, value] of params) {
    if (name.startsWith(FILTER_PARAM) && value) (filter[name.slice(FILTER_PARAM.length)] ??= []).push(value);
  }
  return {
    tab: params.get("tab") === "removed" ? ("removed" as const) : ("current" as const),
    q: params.get("q")?.trim() || undefined,
    offset: Math.max(0, Math.floor(Number(params.get("offset"))) || 0),
    filter,
  };
}

/** M31: a type's list, as its App's page says: tabs, filters, search, groups with totals, and its entities. */
export function AppListPage() {
  const { appId = "", type = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { tab, q, offset, filter } = listState(params);
  const [search, setSearch] = useState(q ?? "");
  const [adding, setAdding] = useState(false);
  const adder = useAction();
  const mover = useAction();
  const navigate = useNavigate();
  const list = useLoad(
    () =>
      api.apps.page(appId, type, {
        tab,
        q,
        offset,
        limit: PAGE,
        filter: Object.keys(filter).length
          ? JSON.stringify(
              Object.fromEntries(Object.entries(filter).map(([field, values]) => [field, values.length === 1 ? values[0] : values])),
            )
          : undefined,
      }),
    [appId, type, params.toString()],
    (signal) => signal.type === "run" && (signal.status === "DONE" || signal.status === "FAILED"),
  );
  // Another list, or the link's search changed (back, a link): the box shows the link's.
  const [shown, setShown] = useState(`${appId}/${type}?${q ?? ""}`);
  if (shown !== `${appId}/${type}?${q ?? ""}`) {
    setShown(`${appId}/${type}?${q ?? ""}`);
    setSearch(q ?? "");
  }
  if (!list.data) return list.error ? <ErrorAlert error={list.error} /> : <Loading />;
  const { page, rows, total, counts, groups, sources } = list.data;
  /** The link changed as `change` says; back to the first rows unless it moves them. */
  const go = (change: (next: URLSearchParams) => void) => {
    const next = new URLSearchParams(params);
    next.delete("offset");
    change(next);
    setParams(next);
  };
  const pick = (field: string, values: string[]) =>
    go((next) => {
      next.delete(FILTER_PARAM + field);
      for (const value of values) next.append(FILTER_PARAM + field, value);
    });
  const setOffset = (to: number) => go((next) => (to > 0 ? next.set("offset", String(to)) : next.delete("offset")));
  const control = (f: (typeof page.filters)[number]) => (
    <FilterControl
      key={f.field}
      filter={f}
      source={f.source ? sources[f.source] : undefined}
      value={filter[f.field] ?? []}
      onChange={(values) => pick(f.field, values)}
    />
  );
  const calendars = page.filters.filter((f) => f.control === "calendar");

  return (
    <>
      <AppHeader
        appId={appId}
        appName={list.data.app}
        current={{ kind: "list", type }}
        trail={[{ label: page.label }]}
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
            appId={appId}
            busy={adder.busy}
            label="Add"
            testId="add-form"
            upload={(field, file) => adder.run(() => api.apps.upload(appId, type, field, file))}
            submit={(values) =>
              void adder
                .run(() => api.apps.add(appId, type, values))
                .then((added) => {
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
            {list.data.chart.more > 0 && (
              <span className="card-subtitle ms-2">
                the top {list.data.chart.series.length}; {list.data.chart.more} more
              </span>
            )}
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
      <div className={calendars.length ? "row g-3" : undefined}>
        {/* M65: a calendar beside the list, picking its day. */}
        {calendars.length > 0 && <div className="col-lg-3 d-flex flex-column gap-3">{calendars.map(control)}</div>}
        <div className={calendars.length ? "col-lg-9" : undefined}>
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
                      onClick={() => go((next) => (t === "current" ? next.delete("tab") : next.set("tab", t)))}
                    >
                      {t === "current" ? "Current" : "Removed"}
                      <span className="badge bg-secondary-lt ms-2">{counts[t]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div className="card-body border-bottom py-2 d-flex flex-wrap gap-2 align-items-center">
              {page.filters.filter((f) => f.control !== "calendar").map(control)}
              <form
                className="ms-auto"
                onSubmit={(e) => {
                  e.preventDefault();
                  go((next) => (search.trim() ? next.set("q", search.trim()) : next.delete("q")));
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
              <ListTable
                page={page}
                rows={rows}
                groups={groups}
                rowLink={(row) => `/a/${appId}/${encodeURIComponent(type)}/${encodeURIComponent(row.key)}`}
                moves={(row, to) => (
                  <button
                    type="button"
                    className="btn btn-sm me-1"
                    disabled={mover.busy}
                    onClick={() => void mover.run(() => api.apps.move(appId, type, row.key, to)).then((moved) => moved && list.reload())}
                    data-testid="row-move"
                  >
                    {to}
                  </button>
                )}
              />
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
        </div>
      </div>
    </>
  );
}

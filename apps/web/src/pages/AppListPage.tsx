import { useState } from "react";
import { IconPlus } from "@tabler/icons-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Empty, ErrorAlert, Loading, Modal, PageHeader } from "../components/ui";
import { EntityButtons } from "../components/EntityButtons";
import { EntityForm } from "../components/EntityForm";
import { ListTable } from "../components/ListTable";
import { SeriesChart } from "../components/SeriesChart";
import { api } from "../lib/endpoints";
import { useAction, useLoad } from "../lib/use-load";

const PAGE = 50;

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
    </>
  );
}

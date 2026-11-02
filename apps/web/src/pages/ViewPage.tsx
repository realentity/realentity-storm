import { type ViewPageView, type ViewTab } from "@ai-me/shared";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Empty, ErrorAlert, Loading, PageHeader } from "../components/ui";
import { RowLink, RowMarks, ViewActions, ViewValue } from "../components/ViewParts";
import { api } from "../lib/endpoints";
import { useLoad } from "../lib/use-load";
import { columnLabel, rowTitle } from "../lib/view";

const PAGE = 50;

/** M27: a pipeline's page, as its `view` says: its collection's rows by tab, searched, with my marks and its buttons. */
export function ViewPage() {
  const { pipelineId = "" } = useParams();
  const [tab, setTab] = useState<ViewTab>("current");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState<string>();
  const [offset, setOffset] = useState(0);
  const page = useLoad(
    () => api.views.page(pipelineId, { tab, q, offset, limit: PAGE }),
    [pipelineId, tab, q, offset],
    (signal) => signal.type === "run" && (signal.status === "DONE" || signal.status === "FAILED"),
  );
  // Another page: start over.
  const [shown, setShown] = useState(pipelineId);
  if (shown !== pipelineId) {
    setShown(pipelineId);
    setTab("current");
    setSearch("");
    setQ(undefined);
    setOffset(0);
  }

  if (!page.data) return page.error ? <ErrorAlert error={page.error} /> : <Loading />;
  const data = page.data;
  const { view } = data;
  const choose = (next: ViewTab) => {
    setTab(next);
    setOffset(0);
  };

  return (
    <>
      <PageHeader
        title={view.menu.label}
        pretitle={
          <>
            From <Link to={`/pipelines/${pipelineId}`}>{data.pipelineName}</Link>
          </>
        }
        actions={<ViewActions pipelineId={pipelineId} view={view} />}
      />
      <Tabs data={data} tab={tab} onChoose={choose} />
      <form
        className="row g-2 mb-3"
        onSubmit={(event) => {
          event.preventDefault();
          setQ(search.trim() || undefined);
          setOffset(0);
        }}
      >
        <div className="col-md-5">
          <input
            className="form-control"
            placeholder="Search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search"
          />
        </div>
      </form>
      {data.rows.length === 0 ? (
        <Empty>{q ? "Nothing matches." : tab === "current" ? `Nothing yet: ${data.pipelineName} adds rows when it runs.` : "None."}</Empty>
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-vcenter card-table">
              <thead>
                <tr>
                  {view.columns.map((column, i) => (
                    <th key={`${column.field}:${i}`} className={column.as === "number" || column.as === "money" ? "text-end" : ""}>
                      {columnLabel(column)}
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.key} data-testid="view-row">
                    {view.columns.map((column, i) => (
                      <td key={`${column.field}:${i}`} className={column.as === "number" || column.as === "money" ? "text-end" : ""}>
                        {i === 0 ? (
                          <Link to={`/v/${pipelineId}/rows/${encodeURIComponent(row.key)}`} title={rowTitle(view, row)}>
                            <ViewValue row={row} column={{ ...column, as: column.as === "link" ? "text" : column.as }} />
                          </Link>
                        ) : (
                          <ViewValue row={row} column={column} />
                        )}
                      </td>
                    ))}
                    <td className="text-end">
                      <div className="d-inline-flex gap-1 align-items-center">
                        <RowLink view={view} row={row} />
                        <RowMarks pipelineId={pipelineId} view={view} row={row} onChanged={page.reload} />
                        <ViewActions pipelineId={pipelineId} view={view} row={row} size="sm" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.total > PAGE && (
            <div className="card-footer d-flex align-items-center">
              <span className="text-secondary small">
                {offset + 1}–{Math.min(offset + PAGE, data.total)} of {data.total}
              </span>
              <div className="ms-auto d-flex gap-2">
                <button type="button" className="btn btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                  Previous
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={offset + PAGE >= data.total}
                  onClick={() => setOffset(offset + PAGE)}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function Tabs({ data, tab, onChoose }: { data: ViewPageView; tab: ViewTab; onChoose: (tab: ViewTab) => void }) {
  const tabs: { id: ViewTab; label: string }[] = [
    { id: "current", label: "Current" },
    ...data.view.marks.map((m) => ({ id: `mark:${m.id}`, label: m.label })),
    ...(data.view.removed ? [{ id: "removed" as const, label: "Removed" }] : []),
  ];
  if (tabs.length === 1) return null;
  return (
    <ul className="nav nav-tabs mb-3" role="tablist">
      {tabs.map((t) => (
        <li key={t.id} className="nav-item">
          <button type="button" role="tab" aria-selected={t.id === tab} className={`nav-link ${t.id === tab ? "active" : ""}`} onClick={() => onChoose(t.id)}>
            {t.label}
            <span className="badge bg-secondary-lt ms-2">{data.counts[t.id] ?? 0}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

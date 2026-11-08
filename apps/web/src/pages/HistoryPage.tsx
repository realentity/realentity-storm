import { RUN_STATUSES, type RunFilter, type RunSummaryView } from "@realentity/storm-shared";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { RunsTable } from "../components/RunsTable";
import { Empty, ErrorAlert, Loading, PageHeader } from "../components/ui";
import { api } from "../lib/endpoints";
import { statusLabel } from "../lib/format";
import { useAction, useLoad } from "../lib/use-load";

const PAGE = 50;
const FILTERS = ["pipelineId", "version", "status", "from", "to", "target"] as const;
type FilterKey = (typeof FILTERS)[number];

/** Every run, newest first, filtered by pipeline, version, status, date and target (docs/design.md §12). */
export function HistoryPage() {
  const [params, setParams] = useSearchParams();
  const filter = Object.fromEntries(FILTERS.map((key) => [key, params.get(key) ?? ""])) as Record<FilterKey, string>;
  const pipelines = useLoad(() => api.pipelines.list(), []);
  const versions = useLoad(
    () => (filter.pipelineId ? api.pipelines.get(filter.pipelineId).then((p) => p.versions) : Promise.resolve([])),
    [filter.pipelineId],
  );
  const query: Partial<RunFilter> = {
    pipelineId: filter.pipelineId || undefined,
    version: filter.version ? Number(filter.version) : undefined,
    status: (filter.status || undefined) as RunFilter["status"],
    from: filter.from || undefined,
    to: filter.to || undefined,
    target: filter.target || undefined,
    limit: PAGE,
  };
  const key = params.toString();
  const runs = useLoad(
    () => api.runs.list(query),
    [key],
    (signal) => signal.type === "run",
  );
  const [older, setOlder] = useState<RunSummaryView[]>([]);
  const [done, setDone] = useState(false);
  const more = useAction();
  const [target, setTarget] = useState(filter.target);

  useEffect(() => {
    setOlder([]);
    setDone(false);
  }, [key]);

  const set = (name: FilterKey, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    if (name === "pipelineId") next.delete("version");
    setParams(next, { replace: true });
  };

  const all = [...(runs.data ?? []), ...older];
  const loadOlder = async () => {
    const last = all[all.length - 1];
    if (!last) return;
    const page = await more.run(() => api.runs.list({ ...query, before: last.startedAt }));
    if (!page) return;
    setOlder((rows) => [...rows, ...page]);
    if (page.length < PAGE) setDone(true);
  };

  return (
    <>
      <PageHeader title="History" />
      <div className="card mb-3">
        <div className="card-body row g-2">
          <div className="col-md-3">
            <select
              className="form-select"
              value={filter.pipelineId}
              onChange={(e) => set("pipelineId", e.target.value)}
              aria-label="Pipeline"
            >
              <option value="">All pipelines</option>
              {pipelines.data?.map((p) => (
                <option key={p.pipelineId} value={p.pipelineId}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="col-md-2">
            <select
              className="form-select"
              value={filter.version}
              disabled={!filter.pipelineId}
              onChange={(e) => set("version", e.target.value)}
              aria-label="Version"
            >
              <option value="">All versions</option>
              {versions.data?.map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version}
                </option>
              ))}
            </select>
          </div>
          <div className="col-md-2">
            <select className="form-select" value={filter.status} onChange={(e) => set("status", e.target.value)} aria-label="Status">
              <option value="">Any status</option>
              {RUN_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {statusLabel(s)}
                </option>
              ))}
            </select>
          </div>
          <div className="col-6 col-md-1">
            <input
              type="date"
              className="form-control"
              value={filter.from}
              onChange={(e) => set("from", e.target.value)}
              aria-label="From"
            />
          </div>
          <div className="col-6 col-md-1">
            <input type="date" className="form-control" value={filter.to} onChange={(e) => set("to", e.target.value)} aria-label="To" />
          </div>
          <form
            className="col-md-3"
            onSubmit={(e) => {
              e.preventDefault();
              set("target", target.trim());
            }}
          >
            <input
              className="form-control"
              placeholder="Target (domain or recipient), Enter"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              onBlur={() => set("target", target.trim())}
              aria-label="Target"
            />
          </form>
        </div>
      </div>
      <ErrorAlert error={runs.error ?? more.error} />
      {!runs.data && runs.loading && <Loading />}
      {runs.data && all.length === 0 && <Empty>No runs match.</Empty>}
      {all.length > 0 && (
        <div className="card">
          <RunsTable runs={all} />
          {!done && (runs.data?.length ?? 0) === PAGE && (
            <div className="card-footer text-center">
              <button type="button" className="btn" disabled={more.busy} onClick={() => void loadOlder()}>
                Load older
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

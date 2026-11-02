import { type RunCostView } from "@ai-me/shared";
import { IconChevronDown, IconChevronRight, IconClipboard, IconDownload } from "@tabler/icons-react";
import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "react-toastify";
import { Empty, ErrorAlert, Loading, Modal, PageHeader, StatusBadge } from "../components/ui";
import { byPipeline, costReport, filterRuns, formatTokens, totals, type CostFilter, type PipelineCost } from "../lib/costs";
import { api } from "../lib/endpoints";
import { formatDateTime, formatUsd } from "../lib/format";
import { useLoad } from "../lib/use-load";

const WINDOWS = [7, 30, 90] as const;
/** Runs shown before "Show more". */
const PAGE = 100;

/** M28: every run and what it cost, by pipeline and step; the report copies out as Markdown. */
export function CostsPage() {
  const [days, setDays] = useState<number>(30);
  const [filter, setFilter] = useState<CostFilter>({ pipelineId: null, dryRuns: true });
  const [sort, setSort] = useState<"newest" | "cost">("cost");
  const [shown, setShown] = useState(PAGE);
  const [report, setReport] = useState<string | null>(null);
  const costs = useLoad(() => api.costs.get(days), [days], (signal) => signal.type === "run");

  const allPipelines = useMemo(() => byPipeline(costs.data?.runs ?? []), [costs.data]);
  const runs = useMemo(() => filterRuns(costs.data?.runs ?? [], filter), [costs.data, filter]);
  const pipelines = useMemo(() => byPipeline(runs), [runs]);
  const sum = useMemo(() => totals(runs), [runs]);
  const sorted = useMemo(
    () => (sort === "cost" ? [...runs].sort((a, b) => b.costUsd - a.costUsd) : runs),
    [runs, sort],
  );

  if (!costs.data) return costs.error ? <ErrorAlert error={costs.error} /> : <Loading />;
  const view = costs.data;

  async function copyReport() {
    const settings = await api.settings.get().catch(() => undefined);
    const text = costReport(view, runs, filter, settings?.models);
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Report copied: paste it into the chat");
    } catch {
      // No clipboard over plain http: show it to copy by hand.
      setReport(text);
    }
  }

  function downloadJson() {
    const blob = new Blob([JSON.stringify({ ...view, runs }, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `ai-me-costs-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <>
      <PageHeader
        title="Costs"
        pretitle="LLM"
        actions={
          <>
            <button type="button" className="btn btn-primary" onClick={() => void copyReport()} data-testid="copy-report">
              <IconClipboard size={18} className="me-1" />
              Copy report
            </button>
            <button type="button" className="btn" onClick={downloadJson} title="Every run with its steps, as JSON">
              <IconDownload size={18} className="me-1" />
              JSON
            </button>
          </>
        }
      />

      <div className="card mb-3">
        <div className="card-body d-flex flex-wrap gap-3 align-items-center">
          <div className="btn-group" role="group" aria-label="Window">
            {WINDOWS.map((d) => (
              <button key={d} type="button" className={`btn ${d === days ? "btn-primary" : ""}`} onClick={() => setDays(d)}>
                {d} days
              </button>
            ))}
          </div>
          <select
            className="form-select w-auto"
            aria-label="Pipeline"
            value={filter.pipelineId ?? ""}
            onChange={(e) => setFilter({ ...filter, pipelineId: e.target.value || null })}
          >
            <option value="">All pipelines</option>
            {allPipelines.map((p) => (
              <option key={p.pipelineId} value={p.pipelineId}>
                {p.pipelineName}
              </option>
            ))}
          </select>
          <label className="form-check form-switch mb-0">
            <input
              className="form-check-input"
              type="checkbox"
              checked={filter.dryRuns}
              onChange={(e) => setFilter({ ...filter, dryRuns: e.target.checked })}
            />
            <span className="form-check-label">Dry runs</span>
          </label>
          {costs.loading && <span className="spinner-border spinner-border-sm text-secondary" role="status" />}
        </div>
      </div>

      {view.truncated && (
        <div className="alert alert-info">Only the newest {view.limit} runs of the last {view.days} days are counted. Pick a shorter window.</div>
      )}

      <div className="row row-cards mb-3">
        <Stat title="Spent" value={formatUsd(sum.costUsd)} testId="costs-total" />
        <Stat title="Runs" value={`${sum.runs}`} note={`${sum.paidRuns} called the LLM${sum.dryRuns ? `, ${sum.dryRuns} dry` : ""}`} />
        <Stat title="Per run" value={formatUsd(sum.perRunUsd)} />
        <Stat title="LLM calls" value={`${sum.calls}`} note={sum.calls ? `${formatUsd(sum.costUsd / sum.calls)} per call` : undefined} />
      </div>

      {runs.length === 0 ? (
        <Empty>No runs in the last {view.days} days.</Empty>
      ) : (
        <>
          <div className="card mb-3">
            <div className="card-header">
              <h3 className="card-title">By pipeline</h3>
              <div className="card-actions small text-secondary">open one to see which steps the money goes to</div>
            </div>
            <div className="table-responsive">
              <table className="table table-vcenter card-table" data-testid="costs-pipelines">
                <thead>
                  <tr>
                    <th>Pipeline</th>
                    <th className="text-end">Runs</th>
                    <th className="text-end">LLM calls</th>
                    <th className="text-end">Per run</th>
                    <th className="text-end">Most expensive run</th>
                    <th className="text-end">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {pipelines.map((p, index) => (
                    <PipelineRow key={p.pipelineId} pipeline={p} initiallyOpen={index === 0} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Runs</h3>
              <div className="card-actions btn-group" role="group" aria-label="Sort">
                <button type="button" className={`btn btn-sm ${sort === "cost" ? "btn-primary" : ""}`} onClick={() => setSort("cost")}>
                  Most expensive
                </button>
                <button type="button" className={`btn btn-sm ${sort === "newest" ? "btn-primary" : ""}`} onClick={() => setSort("newest")}>
                  Newest
                </button>
              </div>
            </div>
            <div className="table-responsive">
              <table className="table table-vcenter card-table" data-testid="costs-runs">
                <thead>
                  <tr>
                    <th />
                    <th>Started</th>
                    <th>Pipeline</th>
                    <th>Trigger</th>
                    <th>Status</th>
                    <th className="text-end">LLM calls</th>
                    <th className="text-end">Tokens in / out</th>
                    <th className="text-end">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.slice(0, shown).map((run) => (
                    <RunRow key={run.runId} run={run} />
                  ))}
                </tbody>
              </table>
            </div>
            {sorted.length > shown && (
              <div className="card-footer text-center">
                <button type="button" className="btn btn-ghost-primary" onClick={() => setShown(shown + PAGE)}>
                  Show more ({sorted.length - shown} left)
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {report !== null && (
        <Modal title="Cost report" size="lg" onClose={() => setReport(null)}>
          <p className="text-secondary">The browser doesn't allow copying here: select the text and copy it.</p>
          <textarea className="form-control font-monospace" rows={18} readOnly value={report} onFocus={(e) => e.target.select()} autoFocus />
        </Modal>
      )}
    </>
  );
}

function Stat({ title, value, note, testId }: { title: string; value: string; note?: string; testId?: string }) {
  return (
    <div className="col-6 col-lg-3">
      <div className="card card-sm">
        <div className="card-body">
          <div className="subheader">{title}</div>
          <div className="h2 mb-0" data-testid={testId}>
            {value}
          </div>
          {note && <div className="small text-secondary">{note}</div>}
        </div>
      </div>
    </div>
  );
}

function PipelineRow({ pipeline: p, initiallyOpen }: { pipeline: PipelineCost; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const Chevron = open ? IconChevronDown : IconChevronRight;
  return (
    <>
      <tr role="button" onClick={() => setOpen(!open)} data-testid="costs-pipeline">
        <td>
          <Chevron size={16} className="me-1 text-secondary" />
          <Link to={`/pipelines/${p.pipelineId}`} onClick={(e) => e.stopPropagation()}>
            {p.pipelineName}
          </Link>
        </td>
        <td className="text-end">
          {p.runs}
          {p.dryRuns > 0 && <span className="text-secondary small"> ({p.dryRuns} dry)</span>}
        </td>
        <td className="text-end">{p.calls}</td>
        <td className="text-end">{formatUsd(p.perRunUsd)}</td>
        <td className="text-end text-secondary">{formatUsd(p.maxRunUsd)}</td>
        <td className="text-end fw-bold">{formatUsd(p.costUsd)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} className="bg-body-tertiary p-0">
            {p.steps.length === 0 ? (
              <div className="text-secondary small p-3">No step of this pipeline called the LLM.</div>
            ) : (
              <table className="table table-sm mb-0" data-testid="costs-steps">
                <thead>
                  <tr>
                    <th className="ps-4">Step</th>
                    <th>Model</th>
                    <th className="text-end" title="LLM calls per run of the pipeline (forEach items and retries count)">
                      Calls / run
                    </th>
                    <th className="text-end" title="Average tokens per call">
                      In / call
                    </th>
                    <th className="text-end">Out / call</th>
                    <th className="text-end" title="Prompt tokens from the cache / written to it, per call">
                      Cache r / w
                    </th>
                    <th className="text-end">Per run</th>
                    <th className="text-end">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {p.steps.map((s) => (
                    <tr key={`${s.stepKey}:${s.type}`}>
                      <td className="ps-4">
                        {s.stepKey} <span className="text-secondary small">{s.type}</span>
                      </td>
                      <td className="small">{s.models.join(" + ") || "?"}</td>
                      <td className="text-end">{(s.calls / p.runs).toFixed(1)}</td>
                      <td className="text-end">{formatTokens(s.inputTokens / s.calls)}</td>
                      <td className="text-end">{formatTokens(s.outputTokens / s.calls)}</td>
                      <td className="text-end text-secondary">
                        {formatTokens(s.cacheReadTokens / s.calls)} / {formatTokens(s.cacheWriteTokens / s.calls)}
                      </td>
                      <td className="text-end">{formatUsd(s.costUsd / p.runs)}</td>
                      <td className="text-end">
                        <ShareBar share={s.share} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function ShareBar({ share }: { share: number }) {
  const percent = Math.round(share * 100);
  return (
    <div className="d-flex align-items-center gap-2 justify-content-end">
      <div className="progress progress-sm" style={{ width: 60 }}>
        <div className="progress-bar" style={{ width: `${percent}%` }} />
      </div>
      <span className="small" style={{ minWidth: 32 }}>
        {percent}%
      </span>
    </div>
  );
}

function RunRow({ run }: { run: RunCostView }) {
  const [open, setOpen] = useState(false);
  const calls = run.steps.reduce((n, s) => n + s.calls, 0);
  const input = run.steps.reduce((n, s) => n + s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens, 0);
  const output = run.steps.reduce((n, s) => n + s.outputTokens, 0);
  const Chevron = open ? IconChevronDown : IconChevronRight;
  return (
    <Fragment>
      <tr role={run.steps.length ? "button" : undefined} onClick={() => run.steps.length && setOpen(!open)} data-testid="costs-run">
        <td className="w-1">{run.steps.length > 0 && <Chevron size={16} className="text-secondary" />}</td>
        <td className="text-nowrap">
          <Link to={`/runs/${run.runId}`} onClick={(e) => e.stopPropagation()}>
            {formatDateTime(run.startedAt)}
          </Link>
        </td>
        <td>
          {run.pipelineName} <span className="text-secondary small">v{run.version}</span>
        </td>
        <td>{run.dryRun ? <span className="badge bg-azure-lt">dry run</span> : run.trigger}</td>
        <td>
          <StatusBadge status={run.status} />
        </td>
        <td className="text-end">{calls || "—"}</td>
        <td className="text-end text-secondary text-nowrap">{calls ? `${formatTokens(input)} / ${formatTokens(output)}` : "—"}</td>
        <td className="text-end fw-bold text-nowrap">{run.costUsd ? formatUsd(run.costUsd) : "—"}</td>
      </tr>
      {open &&
        run.steps.map((s, index) => (
          <tr key={index} className="bg-body-tertiary small">
            <td />
            <td colSpan={2} className="ps-4">
              {s.stepKey}
              {s.itemIndex !== null && <span className="text-secondary">[{s.itemIndex}]</span>} <span className="text-secondary">{s.type}</span>
            </td>
            <td colSpan={2}>{s.models.join(" + ") || "?"}</td>
            <td className="text-end">{s.calls}</td>
            <td className="text-end text-secondary text-nowrap">
              {formatTokens(s.inputTokens)} / {formatTokens(s.outputTokens)}
              {(s.cacheReadTokens > 0 || s.cacheWriteTokens > 0) && (
                <div title="cache read / write">
                  cache {formatTokens(s.cacheReadTokens)} / {formatTokens(s.cacheWriteTokens)}
                </div>
              )}
            </td>
            <td className="text-end text-nowrap">{formatUsd(s.costUsd)}</td>
          </tr>
        ))}
    </Fragment>
  );
}

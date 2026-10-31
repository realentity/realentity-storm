import { type RunDetailView, type RunStepView } from "@ai-me/shared";
import { Fragment, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ErrorAlert, Json, Loading, PageHeader, StatusBadge } from "../components/ui";
import { api } from "../lib/endpoints";
import { formatDateTime, formatDuration, formatUsd } from "../lib/format";
import { useLoad } from "../lib/use-load";

/**
 * A run (README §12): the step timeline, grouped per step and per forEach item, each with its input, output, error
 * and LLM usage, plus the run's proposals. Live while it runs.
 */
export function RunPage() {
  const { runId = "" } = useParams();
  const run = useLoad(
    () => api.runs.get(runId),
    [runId],
    (signal) =>
      ((signal.type === "run" || signal.type === "step" || signal.type === "proposal") && signal.runId === runId) ||
      signal.type === "killSwitch",
  );
  if (!run.data) return run.error ? <ErrorAlert error={run.error} /> : <Loading />;
  const r = run.data;

  return (
    <>
      <PageHeader
        pretitle={
          <Link to={`/pipelines/${r.pipelineId}`} className="text-reset">
            {r.pipelineName} · v{r.version}
          </Link>
        }
        title={
          <span className="d-flex align-items-center gap-2" data-testid="run-status">
            Run {r.dryRun && <span className="badge bg-azure-lt">dry run</span>}
            <StatusBadge status={r.status} />
          </span>
        }
      />
      <div className="row g-3 mb-3">
        <Fact label="Started" value={formatDateTime(r.startedAt)} />
        <Fact
          label="Finished"
          value={r.finishedAt ? `${formatDateTime(r.finishedAt)} (${formatDuration(r.startedAt, r.finishedAt)})` : "—"}
        />
        <Fact label="Trigger" value={r.trigger} />
        <Fact label="LLM cost" value={formatUsd(r.costUsd)} />
      </div>
      {r.summary && (
        <div className={`alert ${r.status === "ABORTED" || r.status === "FAILED" ? "alert-warning" : "alert-info"}`}>{r.summary}</div>
      )}
      {r.resumeAt && <div className="alert alert-info">Held back by a rate limit; continues {formatDateTime(r.resumeAt)}.</div>}
      {r.proposals.length > 0 && <Proposals run={r} />}
      <Timeline steps={r.steps} />
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="col-6 col-md-3">
      <div className="card card-sm">
        <div className="card-body">
          <div className="text-secondary small">{label}</div>
          <div className="fw-bold">{value}</div>
        </div>
      </div>
    </div>
  );
}

function Proposals({ run }: { run: RunDetailView }) {
  return (
    <div className="card mb-3">
      <div className="card-header">
        <h3 className="card-title">Proposals</h3>
      </div>
      <div className="list-group list-group-flush" data-testid="run-proposals">
        {run.proposals.map((p) => (
          <Link
            key={p.proposalId}
            to={`/proposals/${p.proposalId}`}
            className="list-group-item list-group-item-action d-flex gap-2 align-items-center"
          >
            <StatusBadge status={p.status} />
            <strong>{p.stepKey}</strong>
            {p.itemIndex !== null && <span className="text-secondary">#{p.itemIndex + 1}</span>}
            <span className="text-secondary text-truncate">{p.target}</span>
            {p.decision?.reason && <span className="ms-auto small text-secondary text-truncate">“{p.decision.reason}”</span>}
          </Link>
        ))}
      </div>
    </div>
  );
}

/** Steps in run order, a forEach step's items under it. */
function Timeline({ steps }: { steps: RunStepView[] }) {
  const groups = useMemo(() => {
    const byKey = new Map<string, RunStepView[]>();
    for (const step of steps) {
      const list = byKey.get(step.stepKey) ?? [];
      list.push(step);
      byKey.set(step.stepKey, list);
    }
    return [...byKey.entries()].map(([stepKey, rows]) => ({
      stepKey,
      rows: rows.sort((a, b) => (a.itemIndex ?? -1) - (b.itemIndex ?? -1)),
    }));
  }, [steps]);
  const [open, setOpen] = useState<string | null>(null);

  if (steps.length === 0) return <div className="text-secondary">No step has started yet.</div>;
  return (
    <div className="card">
      <div className="table-responsive">
        <table className="table table-vcenter card-table" data-testid="timeline">
          <thead>
            <tr>
              <th>Step</th>
              <th>Status</th>
              <th>Time</th>
              <th>LLM</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <Fragment key={group.stepKey}>
                {group.rows.map((step) => (
                  <Fragment key={step.stepId}>
                    <tr className="cursor-pointer" onClick={() => setOpen(open === step.stepId ? null : step.stepId)}>
                      <td>
                        {step.itemIndex === null ? (
                          <>
                            <strong>{step.stepKey}</strong> <code className="small">{step.type}</code>
                          </>
                        ) : (
                          <span className={step.itemIndex === group.rows[0]?.itemIndex ? "" : "ps-3"}>
                            <strong className={step.itemIndex === group.rows[0]?.itemIndex ? "" : "text-secondary"}>{step.stepKey}</strong>{" "}
                            <code className="small me-2">{step.type}</code>
                            <span className="text-secondary">item #{step.itemIndex + 1}</span>
                          </span>
                        )}
                        {step.error && (
                          <div className="small text-danger text-truncate" style={{ maxWidth: 480 }}>
                            {step.error}
                          </div>
                        )}
                      </td>
                      <td>
                        <StatusBadge status={step.status} />
                      </td>
                      <td className="text-secondary small text-nowrap">{formatDuration(step.startedAt, step.finishedAt)}</td>
                      <td className="text-secondary small text-nowrap">
                        {step.llmUsage
                          ? `${formatUsd(step.llmUsage.costUsd)} · ${step.llmUsage.calls} call(s) · ${step.llmUsage.inputTokens}/${step.llmUsage.outputTokens} tok`
                          : ""}
                      </td>
                    </tr>
                    {open === step.stepId && (
                      <tr>
                        <td colSpan={4} className="bg-body-tertiary">
                          <div className="row g-3">
                            <div className="col-md-6">
                              <div className="fw-bold mb-1">Input</div>
                              <Json value={step.input} />
                            </div>
                            <div className="col-md-6">
                              <div className="fw-bold mb-1">Output</div>
                              <Json value={step.output} />
                            </div>
                            {step.llmUsage && <div className="col-12 small text-secondary">Models: {step.llmUsage.models.join(", ")}</div>}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

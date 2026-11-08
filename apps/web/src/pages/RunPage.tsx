import { type RunDetailView, type RunStepView } from "@realentity/storm-shared";
import { Fragment, useMemo, useState } from "react";
import { IconRefresh } from "@tabler/icons-react";
import { Link, useParams } from "react-router-dom";
import { toast } from "react-toastify";
import { LiveView } from "../components/LiveView";
import { QuestionCard } from "../components/QuestionCard";
import { ErrorAlert, Json, Loading, PageHeader, StatusBadge } from "../components/ui";
import { api } from "../lib/endpoints";
import { formatDateTime, formatDuration, formatUsd } from "../lib/format";
import { useAction, useLoad } from "../lib/use-load";

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
      ((signal.type === "run" || signal.type === "step" || signal.type === "proposal" || signal.type === "takeover") &&
        signal.runId === runId) ||
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
        <div
          className={`alert ${r.status === "ABORTED" || r.status === "FAILED" ? "alert-warning" : "alert-info"}`}
          style={{ whiteSpace: "pre-line" }}
          data-testid="run-summary"
        >
          {r.summary}
        </div>
      )}
      {r.resumeAt && <div className="alert alert-info">Held back by a rate limit; continues {formatDateTime(r.resumeAt)}.</div>}
      {r.retry && <Retry runId={r.runId} retry={r.retry} onRetried={run.reload} />}
      {r.triggerData != null && (
        <details className="card mb-3" data-testid="trigger-data">
          <summary className="card-header cursor-pointer">
            <h3 className="card-title">{r.dryRun ? "Started by an example event (dry run: nothing in it is real)" : "Started by"}</h3>
          </summary>
          <div className="card-body">
            <Json value={r.triggerData} />
          </div>
        </details>
      )}
      {["QUEUED", "RUNNING", "WAITING_FOR_USER"].includes(r.status) && r.steps.some((s) => s.type === "browser.teach") && (
        <div className="alert alert-info" data-testid="teach-guide">
          <strong>Teach mode.</strong> When the live browser below shows the site (it can take a few seconds): accept the cookie banner, search and
          filter until the page shows the list, then press <strong>Continue</strong>. The LLM then writes the recipe and checks it on the page; the
          items it reads are outlined. Press <strong>Continue</strong> again to save the recipe, or <strong>Abort</strong> if the outline is wrong.
        </div>
      )}
      {r.question && <QuestionCard question={r.question} onAnswered={run.reload} />}
      <LiveView run={r} />
      {r.proposals.length > 0 && <Proposals run={r} />}
      <Timeline steps={r.steps} />
      {r.artifacts.length > 0 && <Artifacts run={r} />}
    </>
  );
}

/**
 * M17-T1: a failed run goes on from its failed steps, the outputs before kept (nothing that ran is repeated); not
 * after a side effect failed, which may have gone out.
 */
function Retry({ runId, retry, onRetried }: { runId: string; retry: NonNullable<RunDetailView["retry"]>; onRetried: () => void }) {
  const action = useAction();
  const go = async () => {
    const done = await action.run(() => api.runs.retry(runId));
    if (!done) return;
    toast.info("Going on from the failed step");
    onRetried();
  };
  return (
    <div className="alert alert-secondary d-flex align-items-center gap-3 flex-wrap" data-testid="retry">
      <div className="flex-fill">
        {retry.possible
          ? "Retry goes on from the failed step: the steps before keep their outputs (no LLM call is paid twice), nothing that ran is repeated."
          : `No retry: ${retry.reason}.`}
        <ErrorAlert error={action.error} title="Not retried" />
      </div>
      {retry.possible && (
        <button type="button" className="btn btn-primary" disabled={action.busy} onClick={() => void go()}>
          <IconRefresh size={18} className="me-1" />
          Retry from the failed step
        </button>
      )}
    </div>
  );
}

/** Screenshots as thumbnails; traces (redacted) and downloads as files. */
function Artifacts({ run }: { run: RunDetailView }) {
  const label = (a: RunDetailView["artifacts"][number]) => `${a.stepKey ?? ""}${a.itemIndex !== null ? ` #${a.itemIndex + 1}` : ""}`;
  const shots = run.artifacts.filter((a) => a.kind === "screenshot");
  const files = run.artifacts.filter((a) => a.kind !== "screenshot");
  return (
    <div className="card mt-3" data-testid="artifacts">
      <div className="card-header">
        <h3 className="card-title">Files</h3>
      </div>
      {shots.length > 0 && (
        <div className="card-body d-flex flex-wrap gap-3">
          {shots.map((a) => (
            <a key={a.artifactId} href={api.artifactUrl(a.artifactId)} target="_blank" rel="noreferrer" className="text-center small">
              <img
                src={api.artifactUrl(a.artifactId)}
                alt={`Screenshot of ${label(a)}`}
                style={{ maxWidth: 320 }}
                className="border rounded d-block mb-1"
              />
              {label(a)}
            </a>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="list-group list-group-flush">
          {files.map((a) => (
            <a key={a.artifactId} href={api.artifactUrl(a.artifactId)} className="list-group-item list-group-item-action d-flex gap-2">
              <span className="badge bg-secondary-lt">{a.kind}</span>
              <span>{label(a)}</span>
              {a.kind === "trace" && <span className="text-secondary small">open with npx playwright show-trace</span>}
              <span className="ms-auto text-secondary small">{a.size !== null ? `${Math.max(1, Math.round(a.size / 1024))} KB` : ""}</span>
            </a>
          ))}
        </div>
      )}
    </div>
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

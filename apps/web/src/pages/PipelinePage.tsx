import { type PipelineDetailView } from "@ai-me/shared";
import { IconEye, IconLayoutList, IconPencil, IconPlayerPlay } from "@tabler/icons-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "react-toastify";
import { PipelineChat } from "../components/PipelineChat";
import { PlanView, StepGraphView } from "../components/PlanView";
import { CostCard } from "../components/CostCard";
import { RunsTable } from "../components/RunsTable";
import { ScheduledStartsCard } from "../components/ScheduledStartsCard";
import { WebhookCard } from "../components/WebhookCard";
import { Empty, ErrorAlert, Loading, Modal, PageHeader } from "../components/ui";
import { errorMessage } from "../lib/api";
import { useCatalog } from "../lib/catalog";
import { api } from "../lib/endpoints";
import { formatDateTime, formatUsd } from "../lib/format";
import { describeTrigger } from "../lib/plan";
import { useAction, useLoad } from "../lib/use-load";

/** A pipeline: its current version (plan, graph, policy), versions, recent runs; enable, run, edit. */
export function PipelinePage() {
  const { pipelineId = "" } = useParams();
  const navigate = useNavigate();
  const catalog = useCatalog();
  const pipeline = useLoad(() => api.pipelines.get(pipelineId), [pipelineId]);
  const runs = useLoad(
    () => api.runs.list({ pipelineId, limit: 10 }),
    [pipelineId],
    (signal) => signal.type === "run" && signal.pipelineId === pipelineId,
  );
  const [shownVersion, setShownVersion] = useState<number | null>(null);
  const version = useLoad(
    () => (shownVersion ? api.pipelines.version(pipelineId, shownVersion) : Promise.resolve(null)),
    [pipelineId, shownVersion],
  );
  const action = useAction();
  const [confirming, setConfirming] = useState(false);

  if (!pipeline.data) return pipeline.error ? <ErrorAlert error={pipeline.error} /> : <Loading />;
  const p = pipeline.data;
  const shown = version.data ?? p.current;

  const update = async (body: { enabled?: boolean; essential?: boolean }) => {
    const updated = await action.run(
      () => api.pipelines.update(pipelineId, body),
      (error) => toast.error(errorMessage(error)),
    );
    if (updated) pipeline.reload();
  };

  const start = async (dryRun: boolean) => {
    const run = await action.run(
      () => api.pipelines.run(pipelineId, dryRun),
      (error) => toast.error(errorMessage(error)),
    );
    if (run) void navigate(`/runs/${run.runId}`);
  };

  return (
    <>
      <PageHeader
        pretitle="Pipeline"
        title={p.name}
        actions={
          <>
            {p.current?.definition.view && (
              <Link to={`/v/${pipelineId}`} className="btn" data-testid="open-view">
                <IconLayoutList size={18} className="me-1" />
                {p.current.definition.view.menu.label}
              </Link>
            )}
            <Link to={`/pipelines/${pipelineId}/edit`} className="btn" data-testid="edit-pipeline">
              <IconPencil size={18} className="me-1" />
              {p.hasDraft ? "Continue the draft" : "Edit"}
            </Link>
            <button type="button" className="btn" disabled={!p.current || action.busy} onClick={() => void start(true)}>
              <IconEye size={18} className="me-1" />
              Dry run
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!p.current || action.busy}
              onClick={() => void start(false)}
              data-testid="run-now"
            >
              <IconPlayerPlay size={18} className="me-1" />
              Run now
            </button>
          </>
        }
      />
      <div className="row g-3">
        <div className="col-lg-8 d-flex flex-column gap-3">
          {!p.current && (
            <div className="alert alert-info">
              Not saved yet: only a draft exists. <Link to={`/pipelines/${pipelineId}/edit`}>Review and save it</Link> to enable it.
            </div>
          )}
          {shown && (
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">
                  v{shown.version}
                  {shown.version === p.currentVersion && <span className="badge bg-green-lt ms-2">current</span>}
                </h3>
              </div>
              <div className="card-body">
                <StepGraphView definition={shown.definition} catalog={catalog} />
              </div>
              <div className="card-body border-top">
                <PlanView definition={shown.definition} policy={shown.policy} catalog={catalog} />
              </div>
            </div>
          )}
          <PipelineChat pipelineId={pipelineId} onSaved={() => pipeline.reload()} />
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Recent runs</h3>
              <div className="card-actions">
                <Link to={`/history?pipelineId=${pipelineId}`}>All runs</Link>
              </div>
            </div>
            {runs.data?.length === 0 ? <Empty>No runs yet.</Empty> : runs.data && <RunsTable runs={runs.data} showPipeline={false} />}
          </div>
        </div>
        <div className="col-lg-4 d-flex flex-column gap-3">
          <Switches pipeline={p} busy={action.busy} onChange={(body) => (body.enabled && p.cost.perMonthUsd !== null ? setConfirming(true) : void update(body))} />
          {confirming && (
            <Modal
              title="Enable the schedule?"
              onClose={() => setConfirming(false)}
              footer={
                <>
                  <button type="button" className="btn" onClick={() => setConfirming(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    data-testid="confirm-enable"
                    onClick={() => {
                      setConfirming(false);
                      void update({ enabled: true });
                    }}
                  >
                    Enable
                  </button>
                </>
              }
            >
              It runs {p.cost.runsPerMonth} times in the next 30 days. At {formatUsd(p.cost.perRunUsd ?? 0)} per run (its{" "}
              {p.cost.runs - p.cost.dryRuns > 0 ? "runs" : "dry runs"} of the last {p.cost.days} days), that&apos;s about{" "}
              <strong>{formatUsd(p.cost.perMonthUsd ?? 0)} a month</strong> in LLM calls.
            </Modal>
          )}
          <CostCard cost={p.cost} />
          {p.current && typeof p.current.definition.trigger === "object" && "webhook" in p.current.definition.trigger && (
            <WebhookCard pipelineId={pipelineId} auth={p.current.definition.trigger.webhook} />
          )}
          {p.current && typeof p.current.definition.trigger === "object" && "on" in p.current.definition.trigger && p.current.definition.trigger.on === "flow.later" && (
            <ScheduledStartsCard pipelineId={pipelineId} />
          )}
          {p.current?.definition.steps.some((s) => s.type.startsWith("calendar.")) && <CalendarNotice />}
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Versions</h3>
            </div>
            <div className="list-group list-group-flush" data-testid="versions">
              {p.versions.map((v) => (
                <button
                  key={v.version}
                  type="button"
                  className={`list-group-item list-group-item-action text-start ${shown?.version === v.version ? "active" : ""}`}
                  onClick={() => setShownVersion(v.version === p.currentVersion ? null : v.version)}
                >
                  <div className="d-flex justify-content-between">
                    <strong>v{v.version}</strong>
                    <span className="small text-secondary">{formatDateTime(v.dateCreated)}</span>
                  </div>
                  {v.changeSummary && <div className="small text-secondary text-pre-line">{v.changeSummary}</div>}
                </button>
              ))}
              {p.versions.length === 0 && <div className="list-group-item text-secondary">No saved version yet.</div>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Switches({
  pipeline,
  busy,
  onChange,
}: {
  pipeline: PipelineDetailView;
  busy: boolean;
  onChange: (body: { enabled?: boolean; essential?: boolean }) => void;
}) {
  return (
    <div className="card">
      <div className="card-body d-flex flex-column gap-2">
        <label className="form-check form-switch mb-0">
          <input
            className="form-check-input"
            type="checkbox"
            checked={pipeline.enabled}
            disabled={busy || !pipeline.current}
            onChange={(e) => onChange({ enabled: e.target.checked })}
            data-testid="enable-pipeline"
          />
          <span className="form-check-label">Enabled</span>
          <div className="small text-secondary">
            {!pipeline.current || pipeline.current.definition.trigger === "manual"
              ? "Manual trigger: it runs only when I start it."
              : `${describeTrigger(pipeline.current.definition.trigger)}, while enabled.`}
          </div>
        </label>
        <label className="form-check form-switch mb-0">
          <input
            className="form-check-input"
            type="checkbox"
            checked={pipeline.essential}
            disabled={busy}
            onChange={(e) => onChange({ essential: e.target.checked })}
          />
          <span className="form-check-label">Essential</span>
          <div className="small text-secondary">Keeps running when the monthly LLM budget is spent.</div>
        </label>
      </div>
    </div>
  );
}

/** A pipeline with calendar steps while Google Calendar isn't connected: said before a run waits for it (M14-T1). */
function CalendarNotice() {
  const google = useLoad(() => api.google.status(), []);
  const g = google.data;
  if (!g || g.status === "CONNECTED") return null;
  return (
    <div className="alert alert-warning mb-0" data-testid="calendar-notice">
      This pipeline uses Google Calendar, which {g.connected ? "needs reconnecting" : "isn't connected"}: <Link to="/settings#google">connect it in Settings</Link>,
      or its runs wait for it.
    </div>
  );
}

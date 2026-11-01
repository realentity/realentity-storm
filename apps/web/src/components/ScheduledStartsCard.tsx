import { Link } from "react-router-dom";
import { toast } from "react-toastify";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { useAction, useLoad } from "../lib/use-load";
import { ErrorAlert } from "./ui";

const STATUS_CLASS = { PENDING: "bg-blue-lt", STARTED: "bg-green-lt", CANCELLED: "bg-secondary-lt", SKIPPED: "bg-yellow-lt" } as const;

/** A flow.later pipeline's starts (M14-T3): pending ones I can cancel, and how the last ones went. */
export function ScheduledStartsCard({ pipelineId }: { pipelineId: string }) {
  const starts = useLoad(() => api.scheduledStarts.list(pipelineId), [pipelineId], (signal) => signal.type === "run");
  const action = useAction();
  const cancel = async (id: string) => {
    const done = await action.run(async () => {
      await api.scheduledStarts.cancel(id);
      return true;
    });
    if (!done) return;
    toast.info("Cancelled");
    starts.reload();
  };
  return (
    <div className="card" data-testid="scheduled-starts">
      <div className="card-header">
        <h3 className="card-title">Scheduled starts</h3>
      </div>
      <ErrorAlert error={starts.error ?? action.error} />
      {starts.data?.length === 0 && <div className="card-body text-secondary">Nothing scheduled: another pipeline's flow.later starts this one.</div>}
      {starts.data && starts.data.length > 0 && (
        <div className="list-group list-group-flush">
          {starts.data.map((s) => (
            <div className="list-group-item" key={s.scheduledStartId}>
              <div className="d-flex align-items-center gap-2">
                <span className={`badge ${STATUS_CLASS[s.status]}`}>{s.status.toLowerCase()}</span>
                <span className="flex-fill">{formatDateTime(s.fireAt)}</span>
                {s.status === "PENDING" && (
                  <button type="button" className="btn btn-sm btn-outline-danger" disabled={action.busy} onClick={() => void cancel(s.scheduledStartId)}>
                    Cancel
                  </button>
                )}
              </div>
              <div className="small text-secondary">
                {s.key && <code className="me-2">{s.key}</code>}
                {s.reason}
                {s.runId && <Link to={`/runs/${s.runId}`}>the run</Link>}
                {s.scheduledByRunId && (
                  <>
                    {" "}
                    · <Link to={`/runs/${s.scheduledByRunId}`}>scheduled by</Link>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

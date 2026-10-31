import { type RunSummaryView } from "@ai-me/shared";
import { Link } from "react-router-dom";
import { formatDateTime, formatDuration } from "../lib/format";
import { StatusBadge } from "./ui";

export function RunsTable({ runs, showPipeline = true }: { runs: RunSummaryView[]; showPipeline?: boolean }) {
  return (
    <div className="table-responsive">
      <table className="table table-vcenter card-table" data-testid="runs">
        <thead>
          <tr>
            <th>Started</th>
            {showPipeline && <th>Pipeline</th>}
            <th>Version</th>
            <th>Trigger</th>
            <th>Status</th>
            <th>Summary</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.runId}>
              <td className="text-nowrap">
                <Link to={`/runs/${run.runId}`}>{formatDateTime(run.startedAt)}</Link>
                <div className="small text-secondary">{formatDuration(run.startedAt, run.finishedAt)}</div>
              </td>
              {showPipeline && <td>{run.pipelineName}</td>}
              <td>v{run.version}</td>
              <td>
                {run.trigger}
                {run.dryRun && run.trigger !== "dry-run" && <span className="badge bg-azure-lt ms-1">dry run</span>}
              </td>
              <td>
                <StatusBadge status={run.status} />
              </td>
              <td className="text-secondary text-truncate" style={{ maxWidth: 360 }}>
                {run.summary ?? (run.resumeAt ? `continues ${formatDateTime(run.resumeAt)}` : "")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

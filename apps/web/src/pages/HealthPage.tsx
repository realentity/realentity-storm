import { type HealthCheckView } from "@ai-me/shared";
import { Empty, ErrorAlert, Loading, PageHeader } from "../components/ui";
import { api } from "../lib/endpoints";
import { useLoad } from "../lib/use-load";

const WORKER = { up: ["bg-green-lt", "running"], down: ["bg-red-lt", "down"], unknown: ["bg-secondary-lt", "not known yet"] } as const;

/** M26: server as AI ME sees it: the worker, and what the backup, the restore test and the host's checks reported. */
export function HealthPage() {
  const health = useLoad(() => api.health.get(), []);
  if (!health.data) return health.error ? <ErrorAlert error={health.error} /> : <Loading />;
  const { worker, checks } = health.data;
  const [badge, label] = WORKER[worker.state];
  return (
    <>
      <PageHeader title="Health" pretitle="server" />
      <div className="card mb-3">
        <div className="card-body d-flex align-items-center gap-2">
          <strong>Worker</strong>
          <span className={`badge ${badge}`}>{label}</span>
          <span className="text-secondary small">{worker.lastSeenAt ? `last seen ${when(worker.lastSeenAt)}` : "never seen"}</span>
        </div>
      </div>
      {checks.length === 0 ? (
        <Empty>No reports yet. The nightly backup, the restore test and the host's health check report here once HEALTH_REPORT_TOKEN is set (docs/deployment.md).</Empty>
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table table-vcenter card-table">
              <thead>
                <tr>
                  <th>Check</th>
                  <th>State</th>
                  <th>Last report</th>
                  <th>Expected every</th>
                </tr>
              </thead>
              <tbody>
                {checks.map((check) => (
                  <Row key={check.name} check={check} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function Row({ check }: { check: HealthCheckView }) {
  const state = check.stale ? ["bg-yellow-lt", "no report"] : check.ok ? ["bg-green-lt", "ok"] : ["bg-red-lt", "problem"];
  return (
    <tr data-testid="health-check">
      <td>
        <div>{check.name}</div>
        {check.detail && <div className="small text-secondary">{check.detail}</div>}
      </td>
      <td>
        <span className={`badge ${state[0]}`}>{state[1]}</span>
      </td>
      <td className="text-nowrap">{when(check.reportedAt)}</td>
      <td className="text-secondary">{check.maxAgeHours >= 48 ? `${Math.round(check.maxAgeHours / 24)} days` : `${check.maxAgeHours} h`}</td>
    </tr>
  );
}

function when(at: string): string {
  return new Date(at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

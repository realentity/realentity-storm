import { IconAlertTriangle, IconHandStop } from "@tabler/icons-react";
import { type ProposalView } from "@realentity/storm-shared";
import { Link } from "react-router-dom";
import { BatchCard } from "../components/BatchCard";
import { Empty, ErrorAlert, Loading, PageHeader } from "../components/ui";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { useLoad } from "../lib/use-load";

const group = (p: ProposalView) => `${p.runId}:${p.stepKey}:${p.kind}`;

/** M53: proposals of one step of one run, when there are several: each a batch. */
function batches(proposals: ProposalView[]): ProposalView[][] {
  const groups = new Map<string, ProposalView[]>();
  for (const p of proposals) groups.set(group(p), [...(groups.get(group(p)) ?? []), p]);
  return [...groups.values()].filter((g) => g.length > 1);
}

/** The proposals alone in their step of their run. */
function singles(proposals: ProposalView[]): ProposalView[] {
  const counts = new Map<string, number>();
  for (const p of proposals) counts.set(group(p), (counts.get(group(p)) ?? 0) + 1);
  return proposals.filter((p) => counts.get(group(p)) === 1);
}

/** What waits for the user's decision (docs/design.md §3), oldest first. */
export function InboxPage() {
  const proposals = useLoad(
    () => api.proposals.list(),
    [],
    (signal) => signal.type === "proposal" || signal.type === "killSwitch",
  );

  const takeovers = useLoad(
    () => api.takeovers(),
    [],
    (signal) => signal.type === "takeover" || signal.type === "killSwitch",
  );

  return (
    <>
      <PageHeader title="Inbox" pretitle="Waiting for you" />
      <ErrorAlert error={proposals.error} />
      {takeovers.data && takeovers.data.length > 0 && (
        <div className="card mb-3 border-warning">
          <div className="card-header">
            <h3 className="card-title">The live browser needs you</h3>
          </div>
          <div className="list-group list-group-flush" data-testid="takeovers">
            {takeovers.data.map((t) => (
              <Link key={t.takeoverId} to={`/runs/${t.runId}`} className="list-group-item list-group-item-action d-flex gap-2">
                <IconHandStop size={18} className="text-warning" />
                <span className="fw-bold">{t.pipelineName}</span>
                <span>{t.status === "OPEN" ? t.reason : "taken over"}</span>
                <span className="ms-auto text-secondary small">gives up {formatDateTime(t.expiresAt)}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
      {!proposals.data && proposals.loading && <Loading />}
      {proposals.data?.length === 0 && <Empty>Nothing waits for a decision.</Empty>}
      {/* M53: several of one step of one run (a forEach's items) are decided together. */}
      {batches(proposals.data ?? []).map((batch) => (
        <BatchCard key={`${batch[0].runId}:${batch[0].stepKey}`} proposals={batch} decided={proposals.reload} />
      ))}
      {singles(proposals.data ?? []).length > 0 && (
        <div className="card">
          <div className="list-group list-group-flush" data-testid="inbox">
            {singles(proposals.data ?? []).map((p) => {
              const fresh = p.targets.filter((t) => t.isNew);
              return (
                <Link key={p.proposalId} to={`/proposals/${p.proposalId}`} className="list-group-item list-group-item-action">
                  <div className="row align-items-center">
                    <div className="col-auto">
                      <span className={`badge ${p.kind === "act" ? "bg-red-lt" : "bg-yellow-lt"}`}>
                        {p.kind === "act" ? "act" : "review"}
                      </span>
                    </div>
                    <div className="col text-truncate">
                      <div className="fw-bold">
                        {p.pipelineName} · {p.stepKey}
                        {p.itemIndex !== null && <span className="text-secondary"> #{p.itemIndex + 1}</span>}
                      </div>
                      <div className="text-secondary text-truncate">{p.target}</div>
                    </div>
                    {fresh.length > 0 && (
                      <div className="col-auto text-orange small">
                        <IconAlertTriangle size={16} className="me-1" />
                        new {fresh.map((t) => t.kind).join(", ")}
                      </div>
                    )}
                    <div className="col-auto text-secondary small">{formatDateTime(p.dateCreated)}</div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

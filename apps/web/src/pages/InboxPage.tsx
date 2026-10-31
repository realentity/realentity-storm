import { IconAlertTriangle } from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { Empty, ErrorAlert, Loading, PageHeader } from "../components/ui";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { useLoad } from "../lib/use-load";

/** What waits for my decision (README §3), oldest first. */
export function InboxPage() {
  const proposals = useLoad(
    () => api.proposals.list(),
    [],
    (signal) => signal.type === "proposal" || signal.type === "killSwitch",
  );

  return (
    <>
      <PageHeader title="Inbox" pretitle="Waiting for me" />
      <ErrorAlert error={proposals.error} />
      {!proposals.data && proposals.loading && <Loading />}
      {proposals.data?.length === 0 && <Empty>Nothing waits for a decision.</Empty>}
      {proposals.data && proposals.data.length > 0 && (
        <div className="card">
          <div className="list-group list-group-flush" data-testid="inbox">
            {proposals.data.map((p) => {
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

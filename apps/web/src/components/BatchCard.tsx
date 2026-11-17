import { type ProposalView } from "@realentity/storm-shared";
import { IconAlertTriangle, IconCheck, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "react-toastify";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { useAction } from "../lib/use-load";
import { ErrorAlert } from "./ui";

/** What a payload says in one line: its fields, the values cut short (an encrypted value is *** already). */
function summary(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(" · ")
    .slice(0, 160);
}

/**
 * M53: the proposals of one step of one run (a forEach's items), decided at once: a row per item, all ticked. Approve
 * takes the ticked ones as proposed and rejects the others; an item opens on its own page to edit it.
 */
export function BatchCard({ proposals, decided }: Readonly<{ proposals: ProposalView[]; decided: () => void }>) {
  const [first] = proposals;
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(proposals.map((p) => p.proposalId)));
  const action = useAction();
  const approving = proposals.filter((p) => ticked.has(p.proposalId));
  const rejecting = proposals.filter((p) => !ticked.has(p.proposalId));
  // A new target (a recipient, a site) is approved with the batch, as on a proposal's own page: said on its row.
  const fresh = [...new Set(approving.flatMap((p) => p.targets.filter((t) => t.isNew).map((t) => t.value)))];
  const toggle = (proposalId: string) =>
    setTicked((current) => {
      const next = new Set(current);
      if (next.has(proposalId)) next.delete(proposalId);
      else next.add(proposalId);
      return next;
    });
  const decide = async (approve: ProposalView[], reject: ProposalView[]) => {
    const done = await action.run(() =>
      api.proposals.decideBatch({
        approve: approve.map((p) => p.proposalId),
        reject: reject.map((p) => p.proposalId),
        approveNewTargets: fresh,
      }),
    );
    if (!done) return;
    toast.success([done.approved && `${done.approved} approved`, done.rejected && `${done.rejected} rejected`].filter(Boolean).join(", "));
    decided();
  };
  if (!first) return null;

  return (
    <div className="card mb-3" data-testid="batch">
      <div className="card-header">
        <div>
          <span className={`badge me-2 ${first.kind === "act" ? "bg-red-lt" : "bg-yellow-lt"}`}>{first.kind}</span>
          <span className="fw-bold">
            {first.pipelineName} · {first.stepKey}
          </span>
          <span className="text-secondary"> · {proposals.length} waiting</span>
        </div>
        <div className="card-actions text-secondary small">{formatDateTime(first.dateCreated)}</div>
      </div>
      <ErrorAlert error={action.error} />
      <div className="list-group list-group-flush">
        {proposals.map((p) => {
          const isNew = p.targets.filter((t) => t.isNew);
          return (
            <label key={p.proposalId} className="list-group-item d-flex align-items-center gap-2" data-testid="batch-item">
              <input
                type="checkbox"
                className="form-check-input m-0"
                checked={ticked.has(p.proposalId)}
                onChange={() => toggle(p.proposalId)}
                aria-label={`Approve #${(p.itemIndex ?? 0) + 1}`}
              />
              <span className="text-secondary">#{(p.itemIndex ?? 0) + 1}</span>
              <span className="text-truncate">
                <span className="fw-bold">{p.target}</span>
                <span className="text-secondary small ms-2">{summary(p.originalPayload)}</span>
              </span>
              {isNew.length > 0 && (
                <span className="text-orange small text-nowrap">
                  <IconAlertTriangle size={16} className="me-1" />
                  new {isNew.map((t) => t.kind).join(", ")}
                </span>
              )}
              <Link
                to={`/proposals/${p.proposalId}`}
                className="ms-auto small text-nowrap"
                aria-label={`${p.pipelineName} · ${p.stepKey} #${(p.itemIndex ?? 0) + 1}`}
                onClick={(e) => e.stopPropagation()}
              >
                Open
              </Link>
            </label>
          );
        })}
      </div>
      <div className="card-footer d-flex flex-wrap align-items-center gap-2">
        {fresh.length > 0 && <span className="text-orange small">Approving also allows {fresh.join(", ")}.</span>}
        <button
          type="button"
          className="btn btn-danger ms-auto"
          disabled={action.busy}
          onClick={() => void decide([], proposals)}
          data-testid="batch-reject"
        >
          <IconX size={18} className="me-1" />
          Reject all
        </button>
        <button
          type="button"
          className="btn btn-success"
          disabled={action.busy || approving.length === 0}
          onClick={() => void decide(approving, rejecting)}
          data-testid="batch-approve"
        >
          <IconCheck size={18} className="me-1" />
          Approve {approving.length}
          {rejecting.length > 0 && `, reject ${rejecting.length}`}
        </button>
      </div>
    </div>
  );
}

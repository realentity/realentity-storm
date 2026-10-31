import { canonicalJson, type ProposalView, type TargetView } from "@ai-me/shared";
import { IconAlertTriangle, IconBolt, IconPencil, IconX } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "react-toastify";
import { ErrorAlert, Json, Loading, Modal, PageHeader, StatusBadge } from "../components/ui";
import { api } from "../lib/endpoints";
import { formatDateTime } from "../lib/format";
import { changedFields, editableText, newTargets, readEdits } from "../lib/payload";
import { useAction, useLoad } from "../lib/use-load";

/**
 * One proposal (README §3): the exact payload, its targets with new ones highlighted, and my decision. For gate.act,
 * Act approves the payload shown (edited or not) and the run executes exactly that; for gate.review I pick items.
 */
export function ProposalPage() {
  const { proposalId = "" } = useParams();
  const proposal = useLoad(
    () => api.proposals.get(proposalId),
    [proposalId],
    (signal) => (signal.type === "proposal" && signal.proposalId === proposalId) || signal.type === "killSwitch",
  );

  if (!proposal.data) return proposal.error ? <ErrorAlert error={proposal.error} /> : <Loading />;
  const p = proposal.data;
  const pending = p.status === "PENDING_REVIEW";

  return (
    <>
      <PageHeader
        pretitle={
          <Link to={`/runs/${p.runId}`} className="text-reset">
            {p.pipelineName} · run
          </Link>
        }
        title={
          <>
            {p.kind === "act" ? "Approve action" : "Review items"}: {p.stepKey}
            {p.itemIndex !== null && <span className="text-secondary ms-1">#{p.itemIndex + 1}</span>}
            <span className="ms-2 fs-4">
              <StatusBadge status={p.status} />
            </span>
          </>
        }
      />
      <div className="row g-3">
        <div className="col-lg-8">
          {p.kind === "act" ? (
            <ActPanel key={`${p.proposalId}:${p.status}`} proposal={p} pending={pending} onDecided={proposal.reload} />
          ) : (
            <ReviewPanel key={`${p.proposalId}:${p.status}`} proposal={p} pending={pending} onDecided={proposal.reload} />
          )}
        </div>
        <div className="col-lg-4 d-flex flex-column gap-3">
          {p.kind === "act" && <Targets targets={p.targets} />}
          <Decision proposal={p} />
          {p.reasoning && (
            <div className="card card-sm">
              <div className="card-body">
                <div className="fw-bold mb-1">Why</div>
                {p.reasoning}
              </div>
            </div>
          )}
          <div className="text-secondary small">Proposed {formatDateTime(p.dateCreated)}</div>
        </div>
      </div>
    </>
  );
}

function Targets({ targets }: { targets: TargetView[] }) {
  return (
    <div className="card card-sm">
      <div className="card-header">
        <h3 className="card-title">Targets</h3>
      </div>
      {targets.length === 0 ? (
        <div className="card-body text-secondary">No external targets.</div>
      ) : (
        <ul className="list-group list-group-flush" data-testid="targets">
          {targets.map((t) => (
            <li key={`${t.field}:${t.value}`} className={`list-group-item ${t.isNew ? "bg-orange-lt" : ""}`}>
              <div className="d-flex justify-content-between gap-2">
                <span className="text-break fw-bold">{t.value}</span>
                {t.isNew && (
                  <span className="badge bg-orange text-orange-fg text-nowrap">
                    <IconAlertTriangle size={14} className="me-1" />
                    New {t.kind}
                  </span>
                )}
              </div>
              <div className="small text-secondary">
                {t.field} · {basisText(t.basis)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function basisText(basis: TargetView["basis"]): string {
  if (basis === "static") return "in the pipeline's allowlist";
  if (basis === "provenance") return "comes from the run's own data";
  if (basis === "approved") return "approved by me";
  return "not allowed yet";
}

function Decision({ proposal }: { proposal: ProposalView }) {
  if (!proposal.decision) return null;
  const d = proposal.decision;
  return (
    <div className="card card-sm" data-testid="decision">
      <div className="card-body">
        <div className="fw-bold">{d.kind === "REJECTED" ? "Rejected" : d.kind === "EDITED" ? "Approved with edits" : "Approved"}</div>
        {d.reason && <div className="mt-1">“{d.reason}”</div>}
        <div className="small text-secondary mt-1">{formatDateTime(d.decidedAt)}</div>
      </div>
    </div>
  );
}

function ActPanel({ proposal, pending, onDecided }: { proposal: ProposalView; pending: boolean; onDecided: () => void }) {
  const original = proposal.originalPayload;
  const [editing, setEditing] = useState(false);
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(original).map(([field, value]) => [field, editableText(value)])),
  );
  const [confirming, setConfirming] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [approvedTargets, setApprovedTargets] = useState<string[]>([]);
  const action = useAction();

  const edit = useMemo(() => readEdits(original, texts), [original, texts]);
  const payload = edit.ok ? edit.payload : original;
  const changed = edit.ok ? changedFields(original, edit.payload) : [];
  const introduced = edit.ok ? newTargets(proposal.targets, edit.payload) : [];
  const missingApproval = introduced.filter((t) => !approvedTargets.includes(t));

  const act = async () => {
    const result = await action.run(() =>
      api.proposals.approve(proposal.proposalId, {
        ...(changed.length > 0 ? { payload } : {}),
        approveNewTargets: introduced,
      }),
    );
    setConfirming(false);
    if (!result) return;
    toast.success(changed.length > 0 ? "Approved with edits; the run continues" : "Approved; the run continues");
    onDecided();
  };

  if (!pending) {
    return (
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">{proposal.finalPayload ? "Approved payload" : "Proposed payload"}</h3>
        </div>
        <div className="card-body">
          <Json value={proposal.finalPayload ?? original} maxHeight={600} />
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">Exact payload</h3>
        <div className="card-actions">
          <button type="button" className="btn btn-sm" onClick={() => setEditing((on) => !on)} data-testid="edit-payload">
            <IconPencil size={16} className="me-1" />
            {editing ? "Done editing" : "Edit"}
          </button>
        </div>
      </div>
      <div className="card-body">
        <ErrorAlert error={action.error} title="The decision wasn't saved" />
        {editing ? (
          <div className="d-flex flex-column gap-3">
            {Object.entries(original).map(([field, value]) => {
              const invalid = !edit.ok && edit.invalid.includes(field);
              return (
                <div key={field}>
                  <label className="form-label d-flex justify-content-between" htmlFor={`field-${field}`}>
                    <span>
                      {field} {typeof value !== "string" && <span className="text-secondary small">(JSON)</span>}
                    </span>
                    {changed.includes(field) && <span className="badge bg-blue-lt">edited</span>}
                  </label>
                  <textarea
                    id={`field-${field}`}
                    className={`form-control font-monospace ${invalid ? "is-invalid" : ""}`}
                    rows={Math.min(14, Math.max(2, (texts[field] ?? "").split("\n").length + 1))}
                    value={texts[field] ?? ""}
                    onChange={(e) => setTexts((all) => ({ ...all, [field]: e.target.value }))}
                    data-testid={`field-${field}`}
                  />
                  {invalid && <div className="invalid-feedback">Not valid JSON</div>}
                </div>
              );
            })}
          </div>
        ) : (
          <PayloadFields payload={payload} changed={changed} />
        )}

        {introduced.length > 0 && (
          <div className="alert alert-warning mt-3 mb-0">
            <div className="fw-bold mb-1">The edit adds targets the pipeline wasn't allowed to use</div>
            {introduced.map((target) => (
              <label key={target} className="form-check">
                <input
                  type="checkbox"
                  className="form-check-input"
                  checked={approvedTargets.includes(target)}
                  onChange={(e) => setApprovedTargets((all) => (e.target.checked ? [...all, target] : all.filter((t) => t !== target)))}
                />
                <span className="form-check-label">
                  Allow <strong>{target}</strong> for this action
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
      <div className="card-footer d-flex gap-2 justify-content-end">
        <button
          type="button"
          className="btn btn-outline-danger"
          onClick={() => setRejecting(true)}
          disabled={action.busy}
          data-testid="reject"
        >
          <IconX size={16} className="me-1" />
          Reject
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={action.busy || !edit.ok || missingApproval.length > 0}
          onClick={() => setConfirming(true)}
          data-testid="act"
        >
          <IconBolt size={16} className="me-1" />
          Act{changed.length > 0 ? " with edits" : ""}
        </button>
      </div>

      {confirming && (
        <Modal
          title={`Act: ${proposal.stepKey}`}
          size="lg"
          onClose={() => setConfirming(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={action.busy} onClick={() => void act()} data-testid="act-confirm">
                Act now
              </button>
            </>
          }
        >
          <p>
            The run executes exactly this payload{changed.length > 0 && <> (edited: {changed.join(", ")})</>}. If anything else is needed,
            it pauses and asks.
          </p>
          <Json value={payload} maxHeight={420} />
        </Modal>
      )}
      {rejecting && <RejectModal proposal={proposal} onClose={() => setRejecting(false)} onDecided={onDecided} />}
    </div>
  );
}

function PayloadFields({ payload, changed }: { payload: Record<string, unknown>; changed: string[] }) {
  return (
    <dl className="row mb-0" data-testid="payload">
      {Object.entries(payload).map(([field, value]) => (
        <div key={field} className="col-12 mb-2">
          <dt className="d-flex gap-2">
            {field}
            {changed.includes(field) && <span className="badge bg-blue-lt">edited</span>}
          </dt>
          <dd className="mb-0">{typeof value === "string" ? <div className="payload-text">{value}</div> : <Json value={value} />}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReviewPanel({ proposal, pending, onDecided }: { proposal: ProposalView; pending: boolean; onDecided: () => void }) {
  const items = (proposal.originalPayload as { items?: unknown[] }).items ?? [];
  const chosen = (proposal.finalPayload as { items?: unknown[] } | null)?.items ?? null;
  const chosenKeys = useMemo(() => new Set((chosen ?? []).map((item) => canonicalJson(item))), [chosen]);
  const [selected, setSelected] = useState<Set<number>>(() => new Set(items.map((_, index) => index)));
  const [rejecting, setRejecting] = useState(false);
  const action = useAction();

  const approve = async () => {
    const result = await action.run(() =>
      api.proposals.approve(proposal.proposalId, { payload: { items: items.filter((_, index) => selected.has(index)) } }),
    );
    if (!result) return;
    toast.success(`Continuing with ${selected.size} item(s)`);
    onDecided();
  };

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="card-title">{proposal.target}</h3>
        {pending && (
          <div className="card-actions btn-list">
            <button type="button" className="btn btn-sm" onClick={() => setSelected(new Set(items.map((_, i) => i)))}>
              All
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setSelected(new Set())}>
              None
            </button>
          </div>
        )}
      </div>
      <ErrorAlert error={action.error} title="The decision wasn't saved" />
      <div className="list-group list-group-flush" data-testid="review-items">
        {items.map((item, index) => {
          const on = pending ? selected.has(index) : chosenKeys.has(canonicalJson(item));
          return (
            <label key={index} className={`list-group-item d-flex gap-3 ${!pending && !on ? "opacity-50" : ""}`}>
              <input
                type="checkbox"
                className="form-check-input flex-shrink-0"
                checked={on}
                disabled={!pending}
                onChange={(e) =>
                  setSelected((all) => {
                    const next = new Set(all);
                    if (e.target.checked) next.add(index);
                    else next.delete(index);
                    return next;
                  })
                }
              />
              <div className="flex-fill overflow-hidden">
                <ItemSummary item={item} />
              </div>
            </label>
          );
        })}
      </div>
      {pending && (
        <div className="card-footer d-flex gap-2 justify-content-end">
          <button
            type="button"
            className="btn btn-outline-danger"
            onClick={() => setRejecting(true)}
            disabled={action.busy}
            data-testid="reject"
          >
            Reject all
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={action.busy}
            onClick={() => void approve()}
            data-testid="approve-selection"
          >
            Continue with {selected.size} selected
          </button>
        </div>
      )}
      {rejecting && <RejectModal proposal={proposal} onClose={() => setRejecting(false)} onDecided={onDecided} />}
    </div>
  );
}

/** A list item as a few readable fields (title-ish first), the rest as JSON on demand. */
function ItemSummary({ item }: { item: unknown }) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return <Json value={item} maxHeight={120} />;
  const record = item as Record<string, unknown>;
  const title = ["title", "subject", "name"].map((k) => record[k]).find((v): v is string => typeof v === "string");
  const rest = Object.entries(record)
    .filter(([, v]) => typeof v === "string" && v !== title)
    .slice(0, 3);
  return (
    <>
      {title && <div className="fw-bold text-truncate">{title}</div>}
      {rest.map(([k, v]) => (
        <div key={k} className="small text-secondary text-truncate">
          {k}: {v as string}
        </div>
      ))}
      <details className="small">
        <summary className="text-secondary">all fields</summary>
        <Json value={item} maxHeight={200} />
      </details>
    </>
  );
}

function RejectModal({ proposal, onClose, onDecided }: { proposal: ProposalView; onClose: () => void; onDecided: () => void }) {
  const [reason, setReason] = useState("");
  const action = useAction();
  const navigate = useNavigate();
  const reject = async () => {
    const result = await action.run(() => api.proposals.reject(proposal.proposalId, reason.trim() || undefined));
    if (!result) return;
    toast.info("Rejected");
    onClose();
    onDecided();
    void navigate("/inbox");
  };
  return (
    <Modal
      title="Reject"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={action.busy}
            onClick={() => void reject()}
            data-testid="reject-confirm"
          >
            Reject
          </button>
        </>
      }
    >
      <ErrorAlert error={action.error} />
      <label className="form-label" htmlFor="reason">
        Why? (optional; it helps the pipeline learn)
      </label>
      <textarea id="reason" className="form-control" rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
    </Modal>
  );
}

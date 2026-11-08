import { canonicalJson, type ProposalView } from "@realentity/storm-shared";
import { IconBolt, IconDownload, IconX } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { toast } from "react-toastify";
import { api } from "../lib/endpoints";
import { useAction } from "../lib/use-load";
import { ErrorAlert, Modal } from "./ui";

/** The payload of browser.submit (catalog AgentActionSchema), as the inbox shows and edits it. */
interface Target {
  css: string;
  role: string;
  name: string;
}
type Action =
  | { kind: "navigate"; url: string }
  | { kind: "click"; target: Target }
  | { kind: "type"; target: Target; value: string; source?: "profile" | "written" | "fact" | "asked" | "none" }
  | { kind: "select"; target: Target; value: string }
  | { kind: "check"; target: Target; value: boolean }
  | { kind: "attach"; target: Target; document: string };
interface AttachedFile {
  key: string;
  document: string;
  documentId: string;
  filename: string;
}
interface AgentPayload {
  url: string;
  actions: Action[];
  files: AttachedFile[];
  submit: Target;
  stopBeforeSubmit?: boolean;
  [other: string]: unknown;
}

const SOURCE: Record<string, string> = { profile: "from my profile", written: "written for this job", fact: "from my facts", asked: "my answer", none: "" };

/**
 * What browser.agent did, at browser.submit's gate (M11-T2): every action in order, as the live browser repeats it,
 * typed values editable; the documents it attaches; the final button. Act repeats exactly this and presses it.
 */
export function AgentProposal({ proposal, pending, onDecided, onReject }: { proposal: ProposalView; pending: boolean; onDecided: () => void; onReject: () => void }) {
  const original = (proposal.finalPayload ?? proposal.originalPayload) as AgentPayload;
  const [payload, setPayload] = useState<AgentPayload>(() => structuredClone(original));
  const [confirming, setConfirming] = useState(false);
  const action = useAction();
  const changed = useMemo(() => canonicalJson(payload) !== canonicalJson(proposal.originalPayload), [payload, proposal.originalPayload]);

  const setTyped = (index: number, value: string) =>
    setPayload((p) => ({ ...p, actions: p.actions.map((a, i) => (i === index && a.kind === "type" ? { ...a, value } : a)) }));

  const act = async () => {
    const result = await action.run(() => api.proposals.approve(proposal.proposalId, changed ? { payload } : {}));
    setConfirming(false);
    if (!result) return;
    toast.success(changed ? "Approved with edits; the browser repeats it" : "Approved; the browser repeats it");
    onDecided();
  };

  return (
    <div className="card" data-testid="agent-proposal">
      <div className="card-header">
        <div>
          <h3 className="card-title">What the agent did, to repeat and send</h3>
          <div className="small text-secondary text-break">{payload.url}</div>
        </div>
      </div>
      <div className="card-body">
        <ErrorAlert error={action.error} title="Not saved" />
        <ol className="d-flex flex-column gap-2 ps-3 mb-0">
          {payload.actions.map((a, index) => (
            <li key={index} data-testid={`agent-action-${index}`}>
              {a.kind === "navigate" ? (
                <span>
                  Open <span className="text-break">{a.url}</span>
                </span>
              ) : a.kind === "click" ? (
                <span>
                  Click {a.target.role} <strong>{a.target.name}</strong>
                </span>
              ) : a.kind === "select" ? (
                <span>
                  Pick <strong>{a.value}</strong> in <strong>{a.target.name}</strong>
                </span>
              ) : a.kind === "check" ? (
                <span>
                  {a.value ? "Tick" : "Untick"} <strong>{a.target.name}</strong>
                </span>
              ) : a.kind === "attach" ? (
                <AttachLine name={a.target.name} file={payload.files.find((f) => f.key === a.target.css && f.document === a.document)} />
              ) : (
                <div>
                  <label className="form-label d-flex justify-content-between gap-2 mb-1" htmlFor={`agent-${index}`}>
                    <span>
                      Type into <strong>{a.target.name}</strong>
                    </span>
                    <span className="small text-secondary">{a.source ? SOURCE[a.source] : ""}</span>
                  </label>
                  {a.value.length > 80 || a.value.includes("\n") ? (
                    <textarea id={`agent-${index}`} className="form-control" rows={4} value={a.value} disabled={!pending} onChange={(e) => setTyped(index, e.target.value)} />
                  ) : (
                    <input id={`agent-${index}`} className="form-control" value={a.value} disabled={!pending} onChange={(e) => setTyped(index, e.target.value)} />
                  )}
                </div>
              )}
            </li>
          ))}
          <li>
            Then press <strong>{payload.submit.name}</strong>
          </li>
        </ol>
        <label className="form-check mt-3">
          <input
            type="checkbox"
            className="form-check-input"
            checked={payload.stopBeforeSubmit === true}
            disabled={!pending}
            onChange={(e) => setPayload((p) => ({ ...p, stopBeforeSubmit: e.target.checked }))}
          />
          <span className="form-check-label">Stop before the final button: I press it myself in the live view</span>
        </label>
      </div>
      {pending && (
        <div className="card-footer d-flex gap-2 justify-content-end">
          <button type="button" className="btn btn-outline-danger" onClick={onReject} disabled={action.busy} data-testid="reject">
            <IconX size={16} className="me-1" />
            Reject
          </button>
          <button type="button" className="btn btn-primary" disabled={action.busy} onClick={() => setConfirming(true)} data-testid="act">
            <IconBolt size={16} className="me-1" />
            Act{changed ? " with edits" : ""}
          </button>
        </div>
      )}
      {confirming && (
        <Modal
          title="Repeat and send this?"
          onClose={() => setConfirming(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={action.busy} onClick={() => void act()} data-testid="act-confirm">
                {payload.stopBeforeSubmit ? "Repeat it" : "Repeat and send"}
              </button>
            </>
          }
        >
          <p>
            The live browser opens <strong className="text-break">{new URL(payload.url).hostname}</strong>, repeats these {payload.actions.length}{" "}
            actions, attaches {payload.files.map((f) => f.filename).join(", ") || "no files"}
            {payload.stopBeforeSubmit ? " and stops before sending." : ` and presses "${payload.submit.name}".`} If the page has changed, it waits
            for me.
          </p>
        </Modal>
      )}
    </div>
  );
}

function AttachLine({ name, file }: { name: string; file: AttachedFile | undefined }) {
  return (
    <span className="d-inline-flex gap-2 align-items-center">
      <span>
        Attach <strong>{file?.filename ?? "(not an approved file: it will stop)"}</strong> to <strong>{name}</strong>
      </span>
      {file && (
        <a className="btn btn-icon btn-sm" href={api.documents.fileUrl(file.documentId)} title={`Download ${file.filename}`}>
          <IconDownload size={14} />
        </a>
      )}
    </span>
  );
}

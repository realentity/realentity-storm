import { canonicalJson, type DocumentView, type ProposalView } from "@realentity/storm-shared";
import { IconAlertTriangle, IconBolt, IconDownload, IconX } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { toast } from "react-toastify";
import { api } from "../lib/endpoints";
import { useAction, useLoad } from "../lib/use-load";
import { ErrorAlert, Modal } from "./ui";

/** The payload of browser.fillAndSubmit (catalog FormFieldSchema / FormFileSchema), as the inbox edits it. */
interface Field {
  key: string;
  label: string;
  type: string;
  required: boolean;
  options?: string[];
  value: string | boolean | null;
  source?: "profile" | "written" | "fact" | "asked" | "none";
  /** The fact it came from (M15). */
  fact?: { factId: string; question: string };
}
interface AttachedFile {
  key: string;
  document: string;
  documentId: string;
  sha256: string;
  filename: string;
}
interface FormPayload {
  url: string;
  fields: Field[];
  files: AttachedFile[];
  stopBeforeSubmit?: boolean;
  [other: string]: unknown;
}

const SOURCE: Record<string, string> = {
  profile: "from my profile",
  written: "written for this job",
  fact: "from my facts",
  asked: "my answer when asked",
  none: "",
};

/**
 * An application form at its gate (M10-T6): every field as it will be typed, the files that will be attached (my
 * stored documents, chosen per field), the address it goes to. Act sends exactly this; anything the form asks
 * beyond it pauses the run instead.
 */
export function FormProposal({ proposal, pending, onDecided, onReject }: { proposal: ProposalView; pending: boolean; onDecided: () => void; onReject: () => void }) {
  const original = (proposal.finalPayload ?? proposal.originalPayload) as FormPayload;
  const [payload, setPayload] = useState<FormPayload>(() => structuredClone(original));
  const [confirming, setConfirming] = useState(false);
  const documents = useLoad(() => api.documents.list(), []);
  const action = useAction();
  const changed = useMemo(() => canonicalJson(payload) !== canonicalJson(proposal.originalPayload), [payload, proposal.originalPayload]);
  const fileOf = (key: string) => payload.files.find((f) => f.key === key);
  const missing = payload.fields.filter((f) =>
    f.required && (f.type === "file" ? !fileOf(f.key) : f.value === null || f.value === "" || f.value === false),
  );

  const setValue = (key: string, value: Field["value"]) =>
    setPayload((p) => ({ ...p, fields: p.fields.map((f) => (f.key === key ? { ...f, value, source: f.source } : f)) }));
  const setFile = (key: string, document: DocumentView | null) =>
    setPayload((p) => ({
      ...p,
      files: [
        ...p.files.filter((f) => f.key !== key),
        ...(document
          ? [{ key, document: document.name, documentId: document.documentId, sha256: document.sha256, filename: document.filename }]
          : []),
      ],
    }));

  const act = async () => {
    const result = await action.run(() => api.proposals.approve(proposal.proposalId, changed ? { payload } : {}));
    setConfirming(false);
    if (!result) return;
    toast.success(changed ? "Approved with edits; the browser fills the form" : "Approved; the browser fills the form");
    onDecided();
  };

  return (
    <div className="card" data-testid="form-proposal">
      <div className="card-header">
        <div>
          <h3 className="card-title">Application form</h3>
          <div className="small text-secondary text-break">{payload.url}</div>
        </div>
      </div>
      <div className="card-body">
        <ErrorAlert error={action.error ?? documents.error} title="Not saved" />
        <div className="d-flex flex-column gap-3">
          {payload.fields.map((field) => (
            <div key={field.key} data-testid={`form-field-${field.label}`}>
              <label className="form-label d-flex justify-content-between gap-2" htmlFor={`form-${field.key}`}>
                <span className={field.required ? "required" : ""}>{field.label || field.key}</span>
                <span className="small text-secondary" title={field.fact ? `Fact: ${field.fact.question}` : undefined}>
                  {field.source ? SOURCE[field.source] : ""}
                  {field.fact && field.fact.question !== field.label ? ` ("${field.fact.question}")` : ""}
                </span>
              </label>
              {field.type === "file" ? (
                <FileField
                  id={`form-${field.key}`}
                  attached={fileOf(field.key)}
                  documents={documents.data ?? []}
                  disabled={!pending}
                  onChange={(document) => setFile(field.key, document)}
                />
              ) : (
                <ValueField id={`form-${field.key}`} field={field} disabled={!pending} onChange={(value) => setValue(field.key, value)} />
              )}
            </div>
          ))}
        </div>
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
        {pending && missing.length > 0 && (
          <div className="alert alert-warning mt-3 mb-0">
            <IconAlertTriangle size={16} className="me-1" />
            Required and empty: {missing.map((f) => f.label || f.key).join(", ")}. The site will likely refuse the form, and the run will
            wait for me.
          </div>
        )}
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
          title="Send this application?"
          onClose={() => setConfirming(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={action.busy} onClick={() => void act()} data-testid="act-confirm">
                {payload.stopBeforeSubmit ? "Fill it" : "Fill and send"}
              </button>
            </>
          }
        >
          <p>
            The live browser opens <strong className="text-break">{new URL(payload.url).hostname}</strong>, fills these{" "}
            {payload.fields.filter((f) => f.value !== null && f.type !== "file").length} fields, attaches{" "}
            {payload.files.map((f) => f.filename).join(", ") || "no files"}
            {payload.stopBeforeSubmit ? " and stops before sending." : " and sends it."} If the form asks anything else, it waits for me.
          </p>
        </Modal>
      )}
    </div>
  );
}

function ValueField({ id, field, disabled, onChange }: { id: string; field: Field; disabled: boolean; onChange: (value: Field["value"]) => void }) {
  if (field.type === "checkbox") {
    return (
      <label className="form-check">
        <input id={id} type="checkbox" className="form-check-input" checked={field.value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className="form-check-label">{field.value === true ? "Ticked" : "Not ticked"}</span>
      </label>
    );
  }
  if (field.type === "select" || field.type === "radio") {
    return (
      <select id={id} className="form-select" value={typeof field.value === "string" ? field.value : ""} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">(leave empty)</option>
        {(field.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  const text = typeof field.value === "string" ? field.value : "";
  return field.type === "textarea" ? (
    <textarea id={id} className="form-control" rows={Math.min(10, Math.max(3, text.split("\n").length + 1))} value={text} disabled={disabled} onChange={(e) => onChange(e.target.value || null)} />
  ) : (
    <input id={id} className="form-control" value={text} disabled={disabled} onChange={(e) => onChange(e.target.value || null)} placeholder="(leave empty)" />
  );
}

function FileField({
  id,
  attached,
  documents,
  disabled,
  onChange,
}: {
  id: string;
  attached: AttachedFile | undefined;
  documents: DocumentView[];
  disabled: boolean;
  onChange: (document: DocumentView | null) => void;
}) {
  // The attached version may have been replaced since: it stays selectable as it is.
  const current = attached && !documents.some((d) => d.documentId === attached.documentId) ? attached : null;
  return (
    <div className="d-flex gap-2 align-items-center">
      <select
        id={id}
        className="form-select"
        value={attached?.documentId ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(documents.find((d) => d.documentId === e.target.value) ?? null)}
      >
        <option value="">(no file)</option>
        {current && <option value={current.documentId}>{current.document}: {current.filename} (older version)</option>}
        {documents.map((d) => (
          <option key={d.documentId} value={d.documentId}>
            {d.name}: {d.filename}
          </option>
        ))}
      </select>
      {attached && (
        <a className="btn btn-icon" href={api.documents.fileUrl(attached.documentId)} title={`Download ${attached.filename}`}>
          <IconDownload size={16} />
        </a>
      )}
    </div>
  );
}

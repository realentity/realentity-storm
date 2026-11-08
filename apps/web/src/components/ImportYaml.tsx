import { type BundleCheckView, type BundleItemView } from "@realentity/storm-shared";
import { IconDownload, IconFileImport, IconUpload } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "react-toastify";
import { api } from "../lib/endpoints";
import { useAction } from "../lib/use-load";
import { ErrorAlert, Modal } from "./ui";

const ACTION: Record<BundleItemView["action"], { label: string; badge: string }> = {
  create: { label: "new", badge: "bg-green-lt" },
  update: { label: "next version", badge: "bg-blue-lt" },
  same: { label: "the same: left as it is", badge: "bg-secondary-lt" },
};

/**
 * M35-T5: "Import YAML": a file (or pasted text) holding an App and its pipelines, or pipelines alone, checked as a
 * whole first: what each would be (new, its next version with what changes, the same) and every problem with its line.
 * Import saves all of it, App first, or nothing.
 */
export function ImportYaml({ onImported }: Readonly<{ onImported?: () => void }>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn" onClick={() => setOpen(true)} data-testid="import-yaml">
        <IconFileImport size={18} className="me-1" />
        Import YAML
      </button>
      {open && <ImportDialog onClose={() => setOpen(false)} onImported={onImported} />}
    </>
  );
}

function ImportDialog({ onClose, onImported }: Readonly<{ onClose: () => void; onImported?: () => void }>) {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [check, setCheck] = useState<BundleCheckView | null>(null);
  const [checking, setChecking] = useState(false);
  const checkError = useAction();
  const runCheck = checkError.run;
  const action = useAction();
  const file = useRef<HTMLInputElement>(null);
  const latest = useRef(0);

  useEffect(() => {
    if (!text.trim()) {
      setCheck(null);
      return;
    }
    const ticket = ++latest.current;
    setChecking(true);
    const timer = setTimeout(() => {
      void runCheck(() => api.bundles.check(text)).then((view) => {
        if (ticket !== latest.current) return;
        setCheck(view ?? null);
        setChecking(false);
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [text, runCheck]);

  const read = async (chosen: File | undefined) => {
    if (!chosen) return;
    setText(await chosen.text());
  };

  const todo = check?.items.filter((i) => i.action !== "same") ?? [];
  const save = async () => {
    const saved = await action.run(() => api.bundles.save(text));
    if (!saved) return;
    toast.success(
      `Imported: ${saved.items
        .filter((i) => i.action !== "same")
        .map((i) => i.name)
        .join(", ")}`,
    );
    onImported?.();
    onClose();
    const app = saved.items.find((i) => i.kind === "app");
    const pipelines = saved.items.filter((i) => i.kind === "pipeline");
    if (app?.id) void navigate(`/apps/${app.id}`);
    else if (pipelines.length === 1 && pipelines[0].id) void navigate(`/pipelines/${pipelines[0].id}`);
  };

  return (
    <Modal
      title="Import YAML"
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!check?.ok || checking || todo.length === 0 || action.busy}
            onClick={() => void save()}
            data-testid="import-save"
          >
            <IconUpload size={18} className="me-1" />
            {todo.length > 0 ? `Import ${todo.length}` : "Import"}
          </button>
        </>
      }
    >
      <div className="d-flex flex-column gap-3">
        <div className="text-secondary small">
          An App (its <code>types</code>) and the pipelines that name it, with <code>---</code> between them; or pipelines alone. One you
          already have by name becomes its next version. Everything is checked first; nothing is saved unless all of it can be.
        </div>
        <div className="d-flex gap-2 align-items-center">
          <input
            ref={file}
            type="file"
            accept=".yaml,.yml,text/yaml,application/yaml"
            className="form-control"
            onChange={(e) => void read(e.target.files?.[0])}
            aria-label="A YAML file"
            data-testid="import-file"
          />
        </div>
        <textarea
          className="form-control font-monospace source-editor"
          rows={12}
          spellCheck={false}
          placeholder="…or paste it here"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="The YAML to import"
          data-testid="import-text"
        />
        <ErrorAlert error={checkError.error} />
        <ErrorAlert error={action.error} />
        {check && <CheckList check={check} />}
      </div>
    </Modal>
  );
}

function CheckList({ check }: Readonly<{ check: BundleCheckView }>) {
  return (
    <div className="d-flex flex-column gap-2" data-testid="import-check">
      {check.errors.map((e, i) => (
        <div key={i} className="text-danger small">
          {e.line !== undefined && <span className="me-1">Line {e.line}:</span>}
          {e.message}
        </div>
      ))}
      {check.items.map((item) => (
        <div key={`${item.kind}:${item.name}`} className="border rounded p-2" data-testid="import-item">
          <div className="d-flex align-items-center gap-2">
            <span className="badge bg-secondary-lt">{item.kind === "app" ? "App" : "pipeline"}</span>
            <strong>{item.name}</strong>
            <span className={`badge ${ACTION[item.action].badge} ms-auto`}>{ACTION[item.action].label}</span>
          </div>
          {item.changes.length > 0 && (
            <ul className="small mb-0 mt-1 ps-3">
              {item.changes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
          {item.errors.map((e, i) => (
            <div key={i} className="text-danger small mt-1">
              {e.line !== undefined && <span className="me-1">Line {e.line}:</span>}
              {e.path && <code className="me-1">{e.path}</code>}
              {e.message}
            </div>
          ))}
        </div>
      ))}
      {check.broken.length > 0 && (
        <div className="text-danger small" data-testid="import-broken">
          It would break {check.broken.map((p) => `"${p.name}"`).join(", ")}, which the file leaves out: add{" "}
          {check.broken.length === 1 ? "it" : "them"} to the file, or keep what {check.broken.length === 1 ? "it uses" : "they use"}.
        </div>
      )}
      {check.ok && check.items.every((i) => i.action === "same") && (
        <div className="text-secondary small">Everything in it is as you have it already.</div>
      )}
    </div>
  );
}

/** "Export YAML": the App with its pipelines, or a pipeline, as a file to keep or import elsewhere. */
export function ExportYaml({ what, id }: Readonly<{ what: "app" | "pipeline"; id: string }>) {
  const action = useAction();
  const download = async () => {
    const file = await action.run(
      () => (what === "app" ? api.bundles.exportApp(id) : api.bundles.exportPipeline(id)),
      (error) => toast.error(error instanceof Error ? error.message : "The export failed"),
    );
    if (!file) return;
    const url = URL.createObjectURL(new Blob([file.text], { type: "application/yaml" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = file.filename;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <button type="button" className="btn" disabled={action.busy} onClick={() => void download()} data-testid="export-yaml">
      <IconDownload size={18} className="me-1" />
      Export YAML
    </button>
  );
}

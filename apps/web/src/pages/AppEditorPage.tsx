import { definitionToSource, type DraftTypeView, type RunDetailView } from "@ai-me/shared";
import { IconDeviceFloppy, IconFlask } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "react-toastify";
import { ErrorAlert, Loading, PageHeader, StatusBadge } from "../components/ui";
import { api } from "../lib/endpoints";
import { hasItems, NEW_APP_TEMPLATE, withType } from "../lib/apps";
import { useAction, useLoad } from "../lib/use-load";

/** The finished statuses of a run: its steps' outputs are all there. */
const FINISHED = ["DONE", "FAILED", "WAITING_FOR_USER", "ABORTED"];

/**
 * M30: an App's definition as YAML: saved as its next version. A save that would break one of its pipelines is
 * refused, with what each one uses. Beside it, a type drafted from what a pipeline's source really gives (M30-T7).
 */
export function AppEditorPage() {
  const { appId } = useParams();
  const navigate = useNavigate();
  const existing = useLoad(() => (appId ? api.apps.get(appId) : Promise.resolve(null)), [appId]);
  const [source, setSource] = useState<string | null>(appId ? null : NEW_APP_TEMPLATE);
  const action = useAction();

  useEffect(() => {
    if (existing.data && source === null) setSource(existing.data.source);
  }, [existing.data, source]);

  if (appId && source === null) return existing.error ? <ErrorAlert error={existing.error} /> : <Loading />;
  const text = source ?? "";

  const save = async () => {
    const saved = await action.run(() => (appId ? api.apps.save(appId, text) : api.apps.create(text)));
    if (!saved) return;
    toast.success(`Saved as v${saved.version}`);
    void navigate(`/apps/${saved.appId}`);
  };

  return (
    <>
      <PageHeader
        pretitle={existing.data ? <Link to={`/apps/${existing.data.appId}`}>{existing.data.name}</Link> : <Link to="/apps">Apps</Link>}
        title={existing.data ? `Edit: next is v${(existing.data.version ?? 0) + 1}` : "New App"}
      />
      <div className="row g-3">
        <div className="col-xl-7">
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Definition (YAML)</h3>
            </div>
            <textarea
              className="form-control border-0 font-monospace source-editor"
              rows={26}
              spellCheck={false}
              value={text}
              onChange={(e) => setSource(e.target.value)}
              aria-label="App definition"
              data-testid="app-source"
            />
            <div className="card-footer d-flex">
              <button
                type="button"
                className="btn btn-primary ms-auto"
                disabled={action.busy || !text.trim()}
                onClick={() => void save()}
                data-testid="save-app"
              >
                <IconDeviceFloppy size={18} className="me-1" />
                Save
              </button>
            </div>
          </div>
          <div className="mt-3">
            <ErrorAlert error={action.error} />
          </div>
        </div>
        <div className="col-xl-5">
          <DraftType onAdd={(name, draft) => setSource(withType(text, name, draft))} />
        </div>
      </div>
    </>
  );
}

/**
 * "Try the source": a dry run of a pipeline, then a type drafted from a step's items, without an LLM: the kinds come
 * from the values. Added to the definition to edit before saving.
 */
function DraftType({ onAdd }: { onAdd: (name: string, draft: DraftTypeView) => void }) {
  const pipelines = useLoad(() => api.pipelines.list(), []);
  const [pipelineId, setPipelineId] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [stepKey, setStepKey] = useState("");
  const [name, setName] = useState("Item");
  const [draft, setDraft] = useState<DraftTypeView | null>(null);
  const action = useAction();
  const run = useLoad<RunDetailView | null>(
    () => (runId ? api.runs.get(runId) : Promise.resolve(null)),
    [runId],
    (signal) => (signal.type === "run" || signal.type === "step") && signal.runId === runId,
  );
  const finished = run.data && FINISHED.includes(run.data.status);
  const lists = [
    ...new Set(
      (run.data?.steps ?? []).filter((s) => s.status === "DONE" && (hasItems(s.output) || hasItems(s.input))).map((s) => s.stepKey),
    ),
  ];

  const tryIt = async () => {
    const started = await action.run(async () => {
      const pipeline = await api.pipelines.get(pipelineId);
      const from = pipeline.draft ?? pipeline.current;
      if (!from) throw new Error("This pipeline has no version to try");
      return api.pipelines.dryRun(definitionToSource(from.definition), pipelineId);
    });
    if (!started) return;
    setDraft(null);
    setStepKey("");
    setRunId(started.run.runId);
  };

  const makeDraft = async (key: string) => {
    setStepKey(key);
    const made = await action.run(() => api.apps.draftType({ runId: runId!, stepKey: key }));
    if (made) setDraft(made);
  };

  return (
    <div className="card" data-testid="draft-type">
      <div className="card-header">
        <h3 className="card-title">A type from a source</h3>
      </div>
      <div className="card-body d-flex flex-column gap-2">
        <div className="text-secondary small">
          Dry-runs a pipeline (nothing is sent or saved), then drafts a type from what one of its steps gave: each field&apos;s kind from
          its values. A draft to edit: rename fields, drop what doesn&apos;t matter, mark yours as <code>mine</code>.
        </div>
        <div className="d-flex gap-2">
          <select className="form-select" value={pipelineId} onChange={(e) => setPipelineId(e.target.value)} aria-label="Pipeline to try">
            <option value="">A pipeline…</option>
            {pipelines.data?.map((p) => (
              <option key={p.pipelineId} value={p.pipelineId}>
                {p.name}
              </option>
            ))}
          </select>
          <button type="button" className="btn" disabled={!pipelineId || action.busy} onClick={() => void tryIt()} data-testid="try-source">
            <IconFlask size={18} className="me-1" />
            Try the source
          </button>
        </div>
        {run.data && (
          <div className="d-flex align-items-center gap-2 small">
            Dry run <StatusBadge status={run.data.status} />
            <Link to={`/runs/${run.data.runId}`} className="ms-auto">
              Open the run
            </Link>
          </div>
        )}
        {finished && lists.length === 0 && <div className="text-secondary small">No step gave a list of items to draft from.</div>}
        {lists.length > 0 && (
          <div className="d-flex gap-2 flex-wrap align-items-center">
            <span className="small">From the items of</span>
            {lists.map((key) => (
              <button
                key={key}
                type="button"
                className={`btn btn-sm ${key === stepKey ? "btn-primary" : ""}`}
                disabled={action.busy}
                onClick={() => void makeDraft(key)}
              >
                {key}
              </button>
            ))}
          </div>
        )}
        <ErrorAlert error={action.error} />
        {draft && (
          <>
            <div className="small text-secondary">Drafted from {draft.samples} item(s):</div>
            <pre className="json-block mb-0" data-testid="draft-source">
              {draft.source}
            </pre>
            <div className="d-flex gap-2">
              <input className="form-control" value={name} onChange={(e) => setName(e.target.value)} aria-label="Type name" />
              <button
                type="button"
                className="btn btn-primary text-nowrap"
                disabled={!/^[A-Z][A-Za-z0-9]{0,39}$/.test(name)}
                onClick={() => onAdd(name, draft)}
                data-testid="add-type"
              >
                Add to the App
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

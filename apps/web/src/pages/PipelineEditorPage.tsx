import { type CompilePipelineResponse, type PipelineDetailView, type RunDetailView } from "@ai-me/shared";
import { IconChecks, IconDeviceFloppy, IconEye, IconTrash, IconUpload } from "@tabler/icons-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toast } from "react-toastify";
import { CompileErrors, DiffList, PlanView, StepGraphView } from "../components/PlanView";
import { ErrorAlert, Loading, PageHeader, StatusBadge } from "../components/ui";
import { useCatalog } from "../lib/catalog";
import { api } from "../lib/endpoints";
import { definitionToSource, NEW_PIPELINE_TEMPLATE } from "../lib/source";
import { useAction, useLoad } from "../lib/use-load";

const MAX_UPLOAD_BYTES = 200_000;

/**
 * Authoring and review (README §2.1): paste or upload YAML → check (errors, or the readable plan, step graph, policy
 * and diff against the current version) → dry run → save as the next version. A dry run stores the source as the
 * pipeline's draft; saving the same source keeps that dry run with the new version.
 */
export function PipelineEditorPage() {
  const params = useParams();
  const navigate = useNavigate();
  const catalog = useCatalog();
  const [pipelineId, setPipelineId] = useState<string | undefined>(params.pipelineId);
  const existing = useLoad(() => (params.pipelineId ? api.pipelines.get(params.pipelineId) : Promise.resolve(null)), [params.pipelineId]);
  const [source, setSource] = useState<string | null>(params.pipelineId ? null : NEW_PIPELINE_TEMPLATE);
  const [checked, setChecked] = useState<{ source: string; response: CompilePipelineResponse } | null>(null);
  const [dryRunId, setDryRunId] = useState<string | null>(null);
  const [pipeline, setPipeline] = useState<PipelineDetailView | null>(null);
  const action = useAction();
  const fileInput = useRef<HTMLInputElement>(null);

  // Editing: start from the draft if there is one, else the current version.
  useEffect(() => {
    if (!existing.data || source !== null) return;
    setPipeline(existing.data);
    const from = existing.data.draft ?? existing.data.current;
    setSource(from ? definitionToSource(from.definition) : NEW_PIPELINE_TEMPLATE);
  }, [existing.data, source]);

  if (params.pipelineId && source === null) return existing.error ? <ErrorAlert error={existing.error} /> : <Loading />;
  const text = source ?? "";
  const upToDate = checked?.source === text;
  const result = upToDate ? checked.response.result : null;
  const nextVersion = (pipeline?.currentVersion ?? 0) + 1;

  const check = async () => {
    const response = await action.run(() => api.pipelines.compile(text, pipelineId));
    if (response) setChecked({ source: text, response });
  };

  const dryRun = async () => {
    const response = await action.run(() => api.pipelines.dryRun(text, pipelineId));
    if (!response) return;
    setPipelineId(response.pipeline.pipelineId);
    setPipeline(response.pipeline);
    setDryRunId(response.run.runId);
  };

  const save = async () => {
    const saved = await action.run(() => (pipelineId ? api.pipelines.addVersion(pipelineId, text) : api.pipelines.create(text)));
    if (!saved) return;
    toast.success(`Saved as v${saved.currentVersion}`);
    void navigate(`/pipelines/${saved.pipelineId}`);
  };

  const discard = async () => {
    if (!pipelineId) return;
    const done = await action.run(async () => {
      await api.pipelines.discardDraft(pipelineId);
      return true;
    });
    if (!done) return;
    toast.info("Draft discarded");
    void navigate(pipeline?.currentVersion ? `/pipelines/${pipelineId}` : "/pipelines");
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_UPLOAD_BYTES) return toast.error("That file is too large for a pipeline definition");
    setSource(await file.text());
  };

  return (
    <>
      <PageHeader
        pretitle={pipeline ? <Link to={`/pipelines/${pipelineId}`}>{pipeline.name}</Link> : "New pipeline"}
        title={pipeline?.currentVersion ? `Edit: next is v${nextVersion}` : "Author a pipeline"}
        actions={
          pipeline?.hasDraft && (
            <button type="button" className="btn btn-outline-danger" disabled={action.busy} onClick={() => void discard()}>
              <IconTrash size={18} className="me-1" />
              Discard draft
            </button>
          )
        }
      />
      <div className="row g-3">
        <div className="col-xl-5">
          <div className="card">
            <div className="card-header">
              <h3 className="card-title">Definition (YAML or JSON)</h3>
              <div className="card-actions">
                <input
                  ref={fileInput}
                  type="file"
                  accept=".yaml,.yml,.json,text/yaml,application/json"
                  hidden
                  onChange={(e) => void upload(e)}
                />
                <button type="button" className="btn btn-sm" onClick={() => fileInput.current?.click()}>
                  <IconUpload size={16} className="me-1" />
                  Upload
                </button>
              </div>
            </div>
            <textarea
              className="form-control border-0 font-monospace source-editor"
              rows={24}
              spellCheck={false}
              value={text}
              onChange={(e) => setSource(e.target.value)}
              aria-label="Pipeline definition"
              data-testid="pipeline-source"
            />
            <div className="card-footer d-flex gap-2 flex-wrap">
              <button type="button" className="btn" disabled={action.busy || !text.trim()} onClick={() => void check()} data-testid="check">
                <IconChecks size={18} className="me-1" />
                Check
              </button>
              <button
                type="button"
                className="btn"
                disabled={action.busy || !result?.ok}
                onClick={() => void dryRun()}
                data-testid="dry-run"
              >
                <IconEye size={18} className="me-1" />
                Dry run
              </button>
              <button
                type="button"
                className="btn btn-primary ms-auto"
                disabled={action.busy || !result?.ok}
                onClick={() => void save()}
                data-testid="save"
              >
                <IconDeviceFloppy size={18} className="me-1" />
                Save as v{nextVersion}
              </button>
            </div>
          </div>
        </div>

        <div className="col-xl-7 d-flex flex-column gap-3">
          <ErrorAlert error={action.error} />
          {!checked && <div className="text-secondary">Check the definition to see its plan, what it may do and what changed.</div>}
          {checked && !upToDate && <div className="alert alert-warning">The definition changed since the last check. Check it again.</div>}
          {dryRunId && <DryRunStatus runId={dryRunId} />}
          {result && !result.ok && <CompileErrors errors={result.errors} />}
          {result?.ok && (
            <>
              {result.warnings.length > 0 && (
                <div className="alert alert-info">
                  <ul className="mb-0">
                    {result.warnings.map((w) => (
                      <li key={`${w.path}:${w.message}`}>{w.message}</li>
                    ))}
                  </ul>
                </div>
              )}
              {checked?.response.diff && pipeline?.currentVersion && (
                <DiffList changes={checked.response.diff.changes} against={pipeline.currentVersion} />
              )}
              <div className="card">
                <div className="card-header">
                  <h3 className="card-title">Step graph</h3>
                </div>
                <div className="card-body">
                  <StepGraphView definition={result.definition} catalog={catalog} />
                </div>
              </div>
              <div className="card">
                <div className="card-body">
                  <PlanView definition={result.definition} policy={result.policy} catalog={catalog} />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/** The draft's dry run, live: what it would propose (previews) and how far it got. */
function DryRunStatus({ runId }: { runId: string }) {
  const run = useLoad<RunDetailView>(
    () => api.runs.get(runId),
    [runId],
    (signal) => (signal.type === "run" || signal.type === "step" || signal.type === "proposal") && signal.runId === runId,
  );
  if (!run.data) return <Loading label="Starting the dry run…" />;
  const previews = run.data.proposals.filter((p) => p.status === "PREVIEW");
  const failed = run.data.steps.filter((s) => s.status === "FAILED");
  return (
    <div className="card border-azure" data-testid="dry-run-status">
      <div className="card-body">
        <div className="d-flex align-items-center gap-2">
          <strong>Dry run</strong>
          <StatusBadge status={run.data.status} />
          <Link to={`/runs/${runId}`} className="ms-auto">
            Open the run
          </Link>
        </div>
        <div className="text-secondary small mt-1">
          No side effects: each would-be action is a preview, and its step is skipped.
          {run.data.steps.length > 0 && ` ${run.data.steps.filter((s) => s.status === "DONE").length} step(s) done.`}
        </div>
        {previews.length > 0 && (
          <ul className="mt-2 mb-0">
            {previews.map((p) => (
              <li key={p.proposalId}>
                Would {p.kind === "act" ? "act" : "ask me"}: <strong>{p.stepKey}</strong>
                {p.itemIndex !== null && ` #${p.itemIndex + 1}`} → {p.target}
              </li>
            ))}
          </ul>
        )}
        {failed.map((s) => (
          <div key={s.stepId} className="text-danger small mt-1">
            {s.stepKey}: {s.error}
          </div>
        ))}
      </div>
    </div>
  );
}

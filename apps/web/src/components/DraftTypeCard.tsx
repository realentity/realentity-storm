import {
  addDraftedFields,
  definitionToSource,
  ENTITY_FIELD,
  TYPE_NAME,
  type DraftedField,
  type DraftTypeView,
  type RunDetailView,
} from "@realentity/storm-shared";
import { IconFlask, IconPlus, IconWand } from "@tabler/icons-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { hasItems } from "../lib/apps";
import { api } from "../lib/endpoints";
import { useAction, useLoad } from "../lib/use-load";
import { ErrorAlert, StatusBadge } from "./ui";
import { type DesignerEdit } from "./TypesDesigner";

/** The finished statuses of a run: its steps' outputs are all there. */
const FINISHED = new Set(["DONE", "FAILED", "WAITING_FOR_USER", "ABORTED"]);

type Mode = "sample" | "run";

/**
 * M35-T4: a type from what a source really gives, without an LLM (each field's kind from its values): a sample I
 * paste, or a dry run of a pipeline (nothing sent or saved) and one of its steps. The draft's fields come as rows to
 * keep or leave out, then go into a new type or one that is there.
 */
export function DraftTypeCard({ types, onEdit }: Readonly<{ types: string[]; onEdit: (edit: DesignerEdit) => void }>) {
  const [mode, setMode] = useState<Mode>("sample");
  const [draft, setDraft] = useState<DraftTypeView | null>(null);
  return (
    <div className="card" data-testid="draft-type">
      <div className="card-header">
        <h3 className="card-title">A type from a source</h3>
      </div>
      <div className="card-body d-flex flex-column gap-2">
        <div className="btn-group w-100" role="group">
          {(
            [
              ["sample", "Paste a sample"],
              ["run", "Try a pipeline"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              className={`btn btn-sm ${mode === m ? "btn-primary" : ""}`}
              onClick={() => {
                setMode(m);
                setDraft(null);
              }}
              data-testid={`draft-from-${m}`}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === "sample" ? <FromSample onDraft={setDraft} /> : <FromRun onDraft={setDraft} />}
        {draft && <DraftRows key={draft.source} draft={draft} types={types} onEdit={onEdit} onDone={() => setDraft(null)} />}
      </div>
    </div>
  );
}

function FromSample({ onDraft }: Readonly<{ onDraft: (draft: DraftTypeView) => void }>) {
  const [text, setText] = useState("");
  const action = useAction();
  const make = async () => {
    const made = await action.run(async () => {
      let sample: unknown;
      try {
        sample = JSON.parse(text);
      } catch {
        throw new Error("That isn't JSON: paste what the API or page gives, e.g. [{ ... }, { ... }]");
      }
      return api.apps.draftTypeFromSample(sample);
    });
    if (made) onDraft(made);
  };
  return (
    <>
      <div className="text-secondary small">
        JSON as the source gives it: a list of items, an object with one (an API&apos;s results), or one item.
      </div>
      <textarea
        className="form-control font-monospace"
        rows={6}
        spellCheck={false}
        placeholder='[{ "id": "a1", "name": "WD Purple 8TB", "price": 399, "currency": "BGN" }]'
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="A sample"
        data-testid="draft-sample"
      />
      <button
        type="button"
        className="btn"
        disabled={!text.trim() || action.busy}
        onClick={() => void make()}
        data-testid="draft-sample-go"
      >
        <IconWand size={18} className="me-1" />
        Draft a type
      </button>
      <ErrorAlert error={action.error} />
    </>
  );
}

function FromRun({ onDraft }: Readonly<{ onDraft: (draft: DraftTypeView) => void }>) {
  const pipelines = useLoad(() => api.pipelines.list(), []);
  const [pipelineId, setPipelineId] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [stepKey, setStepKey] = useState("");
  const action = useAction();
  const run = useLoad<RunDetailView | null>(
    () => (runId ? api.runs.get(runId) : Promise.resolve(null)),
    [runId],
    (signal) => (signal.type === "run" || signal.type === "step") && signal.runId === runId,
  );
  const finished = run.data && FINISHED.has(run.data.status);
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
    setStepKey("");
    setRunId(started.run.runId);
  };

  const make = async (key: string) => {
    setStepKey(key);
    const made = await action.run(() => api.apps.draftType({ runId: runId!, stepKey: key }));
    if (made) onDraft(made);
  };

  return (
    <>
      <div className="text-secondary small">
        Dry-runs a pipeline (nothing is sent or saved), then drafts from what one of its steps gave.
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
          Try it
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
              onClick={() => void make(key)}
            >
              {key}
            </button>
          ))}
        </div>
      )}
      <ErrorAlert error={action.error} />
    </>
  );
}

/** The draft's fields as rows: each kept unless I untick it; then into a new type, or one that is there. */
function DraftRows({
  draft,
  types,
  onEdit,
  onDone,
}: Readonly<{ draft: DraftTypeView; types: string[]; onEdit: (edit: DesignerEdit) => void; onDone: () => void }>) {
  const names = Object.keys(draft.type.fields);
  const [kept, setKept] = useState<Set<string>>(new Set(names));
  const [renamed, setRenamed] = useState<Record<string, string>>({});
  const [target, setTarget] = useState("");
  const [typeName, setTypeName] = useState("Item");
  const [key, setKey] = useState(draft.type.key);
  const into = target || typeName;
  const nameOf = (field: string) => renamed[field] ?? field;
  const isNew = target === "";
  const keyKept = kept.has(key);
  const badName = [...kept].some((f) => !ENTITY_FIELD.test(nameOf(f)));
  const ready = kept.size > 0 && !badName && (isNew ? TYPE_NAME.test(typeName) && !types.includes(typeName) && keyKept : true);

  const add = () => {
    const fields: Record<string, DraftedField> = {};
    for (const field of names) {
      if (!kept.has(field)) continue;
      const def = draft.type.fields[field];
      fields[nameOf(field)] = {
        type: def.type,
        ...(def.label ? { label: def.label } : {}),
        ...(def.required ? { required: true } : {}),
        ...(def.values ? { values: def.values } : {}),
        ...(def.currency ? { currency: nameOf(def.currency) } : {}),
      };
    }
    const title = draft.type.title && kept.has(draft.type.title) ? nameOf(draft.type.title) : undefined;
    onEdit((s) => addDraftedFields(s, into, fields, isNew ? nameOf(key) : undefined, isNew ? title : undefined));
    onDone();
  };

  return (
    <div className="d-flex flex-column gap-2" data-testid="draft-rows">
      <div className="small text-secondary">
        Drafted from {draft.samples} item{draft.samples === 1 ? "" : "s"}: untick what doesn&apos;t matter, rename what you&apos;d call
        otherwise.
      </div>
      <div className="table-responsive">
        <table className="table table-sm table-vcenter mb-0">
          <tbody>
            {names.map((field) => {
              const def = draft.type.fields[field];
              return (
                <tr key={field} data-testid="draft-row" className={kept.has(field) ? undefined : "text-secondary"}>
                  <td className="w-1">
                    <input
                      type="checkbox"
                      className="form-check-input"
                      checked={kept.has(field)}
                      onChange={(e) => {
                        const next = new Set(kept);
                        if (e.target.checked) next.add(field);
                        else next.delete(field);
                        setKept(next);
                      }}
                      aria-label={`Keep ${field}`}
                      data-testid="draft-keep"
                    />
                  </td>
                  <td>
                    <input
                      className={`form-control form-control-sm font-monospace ${ENTITY_FIELD.test(nameOf(field)) ? "" : "is-invalid"}`}
                      value={nameOf(field)}
                      onChange={(e) => setRenamed({ ...renamed, [field]: e.target.value })}
                      aria-label={`Name for ${field}`}
                    />
                    <div
                      className="small text-secondary text-truncate"
                      style={{ maxWidth: 220 }}
                      title={draft.examples?.[field]?.join(" · ")}
                    >
                      {draft.examples?.[field]?.join(" · ")}
                    </div>
                  </td>
                  <td className="small text-nowrap" data-testid="draft-kind">
                    {def.type}
                    {def.required && " · always"}
                    {def.currency && ` · in ${nameOf(def.currency)}`}
                    {def.values && ` · ${def.values.join(", ")}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="d-flex gap-2 align-items-center flex-wrap small">
        <span>Into</span>
        <select
          className="form-select form-select-sm w-auto"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          aria-label="Into which type"
          data-testid="draft-into"
        >
          <option value="">a new type</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {isNew && (
          <>
            <input
              className={`form-control form-control-sm w-auto ${TYPE_NAME.test(typeName) && !types.includes(typeName) ? "" : "is-invalid"}`}
              value={typeName}
              onChange={(e) => setTypeName(e.target.value)}
              aria-label="Type name"
              data-testid="draft-type-name"
            />
            <span>keyed by</span>
            <select
              className="form-select form-select-sm w-auto"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              aria-label="Its key"
              data-testid="draft-key"
            >
              {names
                .filter((f) => ["text", "url", "email", "number"].includes(draft.type.fields[f].type))
                .map((f) => (
                  <option key={f} value={f}>
                    {nameOf(f)}
                  </option>
                ))}
            </select>
          </>
        )}
      </div>
      {isNew && !keyKept && <div className="small text-danger">Keep its key, the field that tells them apart.</div>}
      <button type="button" className="btn btn-primary" disabled={!ready} onClick={add} data-testid="add-type">
        <IconPlus size={18} className="me-1" />
        {isNew ? `Add ${typeName} with ${kept.size} field${kept.size === 1 ? "" : "s"}` : `Add the new ones to ${target}`}
      </button>
    </div>
  );
}

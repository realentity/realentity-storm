import { RULE_STEP_TYPES, type RuleStatusName, type RuleStepType, type RuleView } from "@realentity/storm-shared";
import { IconBulb, IconCheck, IconPencil, IconPlayerPause, IconPlayerPlay, IconPlus, IconTrash, IconX } from "@tabler/icons-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { toast } from "react-toastify";
import { Empty, ErrorAlert, Loading, Modal, PageHeader, StatusBadge } from "../components/ui";
import { api } from "../lib/endpoints";
import { formatDateTime, formatUsd } from "../lib/format";
import { useAction, useLoad } from "../lib/use-load";

/**
 * What the drafts learn from my decisions (README §8): rules I wrote or approved (injected into the LLM steps),
 * what the nightly reflection suggests (never active until I approve it), and the few-shot examples kept so far.
 */
export function RulesPage() {
  const learning = useLoad(
    () => api.learning.get(),
    [],
    (signal) => signal.type === "learning",
  );
  const pipelines = useLoad(() => api.pipelines.list(), []);
  const [editing, setEditing] = useState<RuleView | "new" | null>(null);
  const action = useAction();

  const setStatus = async (rule: RuleView, status: RuleStatusName, message: string) => {
    if (await action.run(() => api.learning.updateRule(rule.ruleId, { status }))) {
      toast.success(message);
      learning.reload();
    }
  };
  /** Runs a call that returns nothing; true once it succeeded. */
  const done = (call: () => Promise<void>) =>
    action.run(async () => {
      await call();
      return true;
    });
  const remove = async (rule: RuleView) => {
    if (await done(() => api.learning.deleteRule(rule.ruleId))) learning.reload();
  };
  const dismiss = async (suggestionId: string, status: "DONE" | "DISMISSED") => {
    if (await done(() => api.learning.updateSuggestion(suggestionId, status))) learning.reload();
  };
  const reflect = async () => {
    if (await done(() => api.learning.reflect())) {
      toast.info("Reflection requested: suggestions appear here when Claude has answered (usually within an hour)");
    }
  };

  const data = learning.data;
  const byStatus = (status: RuleStatusName) => data?.rules.filter((r) => r.status === status) ?? [];
  const suggested = byStatus("SUGGESTED");
  const active = byStatus("ACTIVE");
  const disabled = byStatus("DISABLED");
  const reflecting = data?.reflections.some((r) => r.status === "SUBMITTED") ?? false;

  return (
    <>
      <PageHeader
        title="Rules"
        pretitle="Learning"
        actions={
          <>
            <button type="button" className="btn" disabled={action.busy || reflecting} onClick={() => void reflect()} data-testid="reflect">
              <IconBulb size={18} className="me-1" />
              {reflecting ? "Reflecting…" : "Reflect now"}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setEditing("new")} data-testid="add-rule">
              <IconPlus size={18} className="me-1" />
              Add rule
            </button>
          </>
        }
      />
      <p className="text-secondary">
        Active rules go into every matching LLM step&apos;s instructions. Every night, Claude reads my edits and rejections and suggests new
        ones; a suggestion does nothing until I approve it.
      </p>
      <ErrorAlert error={learning.error ?? action.error} />
      {!data && learning.loading && <Loading />}

      {data && (
        <>
          {suggested.length > 0 && (
            <RuleCard title="Suggested" rules={suggested} testId="suggested-rules">
              {(rule) => (
                <>
                  <button
                    type="button"
                    className="btn btn-sm btn-success"
                    disabled={action.busy}
                    onClick={() => void setStatus(rule, "ACTIVE", "Rule approved")}
                  >
                    <IconCheck size={16} className="me-1" />
                    Approve
                  </button>
                  <button type="button" className="btn btn-sm ms-1" onClick={() => setEditing(rule)} title="Edit">
                    <IconPencil size={16} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost-secondary ms-1"
                    disabled={action.busy}
                    onClick={() => void setStatus(rule, "DISABLED", "Suggestion dismissed")}
                    title="Dismiss"
                  >
                    <IconX size={16} />
                  </button>
                </>
              )}
            </RuleCard>
          )}

          {data.suggestions.length > 0 && (
            <div className="card mb-3" data-testid="pipeline-suggestions">
              <div className="card-header">
                <h3 className="card-title">Pipeline suggestions</h3>
              </div>
              <div className="list-group list-group-flush">
                {data.suggestions.map((s) => (
                  <div key={s.suggestionId} className="list-group-item">
                    <div className="row align-items-center">
                      <div className="col">
                        <Link to={`/pipelines/${s.pipelineId}`}>{s.pipelineName}</Link>: {s.text}
                        {s.rationale && <div className="small text-secondary">{s.rationale}</div>}
                      </div>
                      <div className="col-auto text-nowrap">
                        <Link
                          to={`/pipelines/${s.pipelineId}`}
                          className="btn btn-sm btn-primary me-1"
                          title="The pipeline's chat turns it into a diff"
                        >
                          Change in chat
                        </Link>
                        <button
                          type="button"
                          className="btn btn-sm"
                          disabled={action.busy}
                          onClick={() => void dismiss(s.suggestionId, "DONE")}
                        >
                          Done
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost-secondary ms-1"
                          disabled={action.busy}
                          onClick={() => void dismiss(s.suggestionId, "DISMISSED")}
                          title="Dismiss"
                        >
                          <IconX size={16} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {active.length === 0 ? (
            <div className="card mb-3">
              <div className="card-body">
                <Empty>No active rules yet.</Empty>
              </div>
            </div>
          ) : (
            <RuleCard title="Active" rules={active} testId="active-rules">
              {(rule) => (
                <>
                  <button type="button" className="btn btn-sm" onClick={() => setEditing(rule)} title="Edit">
                    <IconPencil size={16} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm ms-1"
                    disabled={action.busy}
                    onClick={() => void setStatus(rule, "DISABLED", "Rule disabled")}
                    title="Disable"
                  >
                    <IconPlayerPause size={16} />
                  </button>
                </>
              )}
            </RuleCard>
          )}

          {disabled.length > 0 && (
            <RuleCard title="Disabled and dismissed" rules={disabled} testId="disabled-rules" muted>
              {(rule) => (
                <>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={action.busy}
                    onClick={() => void setStatus(rule, "ACTIVE", "Rule enabled")}
                    title="Enable"
                  >
                    <IconPlayerPlay size={16} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost-danger ms-1"
                    disabled={action.busy}
                    onClick={() => void remove(rule)}
                    title="Delete"
                  >
                    <IconTrash size={16} />
                  </button>
                </>
              )}
            </RuleCard>
          )}

          <div className="row row-cards">
            <div className="col-md-6">
              <div className="card">
                <div className="card-header">
                  <h3 className="card-title">Examples</h3>
                </div>
                <div className="card-body">
                  {!data.embeddings && (
                    <div className="alert alert-warning">
                      OPENAI_API_KEY is not set: drafts are written without examples. Approved replies are still kept and embedded once it
                      is set.
                    </div>
                  )}
                  {data.examples.length === 0 ? (
                    <div className="text-secondary">None yet: every reply I approve becomes one.</div>
                  ) : (
                    <ul className="mb-0">
                      {data.examples.map((e) => (
                        <li key={e.stepType}>
                          <code>{e.stepType}</code>: {e.count} approved output(s); each draft sees the 3 most similar
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
            <div className="col-md-6">
              <div className="card">
                <div className="card-header">
                  <h3 className="card-title">Recent reflections</h3>
                </div>
                {data.reflections.length === 0 ? (
                  <div className="card-body text-secondary">
                    None yet: the first runs tonight at 03:30, once there are edits or rejections.
                  </div>
                ) : (
                  <div className="table-responsive">
                    <table className="table table-vcenter card-table" data-testid="reflections">
                      <tbody>
                        {data.reflections.map((r) => (
                          <tr key={r.reflectionId}>
                            <td className="text-secondary">{formatDateTime(r.startedAt)}</td>
                            <td>
                              <StatusBadge status={r.status} />
                            </td>
                            <td>{r.decisions} decision(s)</td>
                            <td className="text-secondary">{r.costUsd === null ? "" : formatUsd(r.costUsd)}</td>
                            {r.error && <td className="text-danger small">{r.error}</td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {editing && (
        <RuleForm
          rule={editing === "new" ? null : editing}
          pipelines={pipelines.data?.map((p) => ({ pipelineId: p.pipelineId, name: p.name })) ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            learning.reload();
          }}
        />
      )}
    </>
  );
}

function scope(rule: RuleView): string {
  return `${rule.stepType ?? "every LLM step"} · ${rule.pipelineName ?? (rule.pipelineId ? "a deleted pipeline" : "every pipeline")}`;
}

function RuleCard({
  title,
  rules,
  testId,
  muted,
  children,
}: {
  title: string;
  rules: RuleView[];
  testId: string;
  muted?: boolean;
  children: (rule: RuleView) => ReactNode;
}) {
  return (
    <div className="card mb-3" data-testid={testId}>
      <div className="card-header">
        <h3 className="card-title">{title}</h3>
      </div>
      <div className="list-group list-group-flush">
        {rules.map((rule) => (
          <div key={rule.ruleId} className="list-group-item">
            <div className="row align-items-center">
              <div className={`col ${muted ? "text-secondary" : ""}`}>
                <div>{rule.text}</div>
                <div className="small text-secondary">
                  {scope(rule)}
                  {rule.source?.startsWith("reflection:") ? " · suggested by reflection" : ""}
                </div>
                {rule.rationale && <div className="small text-secondary fst-italic">{rule.rationale}</div>}
              </div>
              <div className="col-auto text-nowrap">{children(rule)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RuleForm({
  rule,
  pipelines,
  onClose,
  onSaved,
}: {
  rule: RuleView | null;
  pipelines: { pipelineId: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [text, setText] = useState(rule?.text ?? "");
  const [stepType, setStepType] = useState(rule?.stepType ?? "");
  const [pipelineId, setPipelineId] = useState(rule?.pipelineId ?? "");
  const action = useAction();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const body = { text: text.trim(), stepType: (stepType || null) as RuleStepType | null, pipelineId: pipelineId || null };
    const saved = await action.run(() => (rule ? api.learning.updateRule(rule.ruleId, body) : api.learning.createRule(body)));
    if (!saved) return;
    toast.success(rule ? "Rule saved" : "Rule added and active");
    onSaved();
  };

  return (
    <Modal title={rule ? "Edit rule" : "Add a rule"} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} data-testid="rule-form">
        <ErrorAlert error={action.error} title="Not saved" />
        <div className="mb-3">
          <label className="form-label" htmlFor="rule-text">
            Rule
          </label>
          <textarea
            id="rule-text"
            className="form-control"
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Keep recruiter replies under 80 words."
            required
          />
          <div className="form-hint">One instruction about how to write. It applies to every matching step from the next run on.</div>
        </div>
        <div className="row">
          <div className="col-md-6 mb-3">
            <label className="form-label" htmlFor="rule-step">
              Step type
            </label>
            <select id="rule-step" className="form-select" value={stepType} onChange={(e) => setStepType(e.target.value)}>
              <option value="">Every LLM step</option>
              {RULE_STEP_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="col-md-6 mb-3">
            <label className="form-label" htmlFor="rule-pipeline">
              Pipeline
            </label>
            <select id="rule-pipeline" className="form-select" value={pipelineId} onChange={(e) => setPipelineId(e.target.value)}>
              <option value="">Every pipeline</option>
              {pipelines.map((p) => (
                <option key={p.pipelineId} value={p.pipelineId}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="d-flex justify-content-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={action.busy}>
            {rule ? "Save" : "Add"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

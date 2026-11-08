import {
  addStep,
  allowDomain,
  allowedDomainsOf,
  moveStep,
  notAllowedHost,
  removeStep,
  renameStep,
  setPipelineProperty,
  setStepInput,
  setStepOption,
  STEP_ID,
  type CompileIssue,
  type CredentialView,
  type StepTypeView,
} from "@realentity/storm-shared";
import {
  IconAlertTriangle,
  IconArrowDown,
  IconArrowUp,
  IconChevronDown,
  IconChevronRight,
  IconPlus,
  IconWorld,
  IconX,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { HELP } from "../lib/help";
import { issuePlace, loosePipeline, type LooseStep } from "../lib/step-cards";
import { resolve } from "../lib/schema-form";
import { SchemaField } from "./SchemaForm";
import { TriggerCard } from "./TriggerCard";
import { type TriggerTypes } from "../lib/step-cards";
import { CommitInput, type DesignerEdit } from "./TypesDesigner";
import { Modal } from "./ui";

/**
 * M36-T2/T3/T5: a pipeline as cards: its name and App, its trigger, then a card per step with its inputs as a form
 * from the catalog, its problems on it. Every change an edit of the YAML, which stays one tab away.
 */
export function StepCards({
  source,
  onEdit,
  editable,
  catalog,
  issues,
  apps,
  types,
  pipelines,
  credentials,
  picker,
  tryHere,
  marked,
}: Readonly<{
  source: string;
  onEdit: (edit: DesignerEdit) => void;
  editable: boolean;
  catalog: StepTypeView[];
  issues: CompileIssue[];
  /** My Apps' names, to belong to one. */
  apps: string[];
  /** The App's types, for the trigger and data steps. */
  types: TriggerTypes;
  pipelines: string[];
  credentials: CredentialView[];
  /** M36-T4: the data picker for a step's input: what goes beside it. */
  picker?: (step: number, input: string, kind: "whole" | "insert", onPick: (reference: string) => void) => ReactNode;
  /** M37-T3: under a card, trying the pipeline up to it and what it gave. */
  tryHere?: (step: LooseStep) => ReactNode;
  /** M38-T5: what the builder's proposal changed: step ids and "trigger". */
  marked?: Set<string>;
}>) {
  const pipeline = loosePipeline(source);
  const [adding, setAdding] = useState<number | null>(null);
  if (!pipeline) return <div className="card-body text-secondary">The YAML doesn&apos;t read as a pipeline: fix it on the YAML tab.</div>;
  const byType = new Map(catalog.map((s) => [s.type, s]));
  const general = issues.filter((i) => {
    const place = issuePlace(i.path);
    return !place.trigger && place.step === undefined;
  });

  return (
    <div className="card-body d-flex flex-column gap-3" data-testid="step-cards">
      {!editable && <div className="alert alert-warning mb-0">The YAML has errors: fix them on the YAML tab to change the cards.</div>}
      <div className="d-flex gap-2 flex-wrap align-items-center">
        <CommitInput
          value={pipeline.name}
          className="form-control fw-bold w-auto"
          valid={(v) => v.length > 0 && v.length <= 100}
          onCommit={(v) => onEdit((s) => setPipelineProperty(s, "name", v))}
          disabled={!editable}
          ariaLabel="The pipeline's name"
          help={HELP.pipelineName}
          testId="pipeline-name"
        />
        <select
          className="form-select w-auto"
          value={pipeline.app}
          disabled={!editable}
          onChange={(e) => onEdit((s) => setPipelineProperty(s, "app", e.target.value))}
          aria-label="Its App"
          title={HELP.pipelineApp}
          data-testid="pipeline-app"
        >
          <option value="">in no App</option>
          {pipeline.app && !apps.includes(pipeline.app) && <option value={pipeline.app}>{pipeline.app}</option>}
          {apps.map((a) => (
            <option key={a} value={a}>
              in {a}
            </option>
          ))}
        </select>
        <div className="flex-fill">
          <CommitInput
            value={pipeline.description}
            placeholder="What it does, in a sentence"
            onCommit={(v) => onEdit((s) => setPipelineProperty(s, "description", v))}
            disabled={!editable}
            help={HELP.pipelineDescription}
            ariaLabel="The pipeline's description"
          />
        </div>
      </div>
      <AllowedSites source={source} onEdit={onEdit} editable={editable} />
      {general.map((i) => (
        <div key={i.path + i.message} className="text-danger small" data-testid="card-issue">
          {i.path && <code className="me-1">{i.path}</code>}
          {i.message}
        </div>
      ))}
      {marked?.has("trigger") && <BuilderMark what="The trigger" />}
      <TriggerCard
        trigger={pipeline.trigger}
        onEdit={onEdit}
        editable={editable}
        issues={issues.filter((i) => issuePlace(i.path).trigger)}
        types={types}
        pipelines={pipelines}
      />
      {pipeline.steps.map((step, index) => (
        <div key={`${index}:${step.id}`}>
          <AddHere onAdd={() => setAdding(index - 1)} disabled={!editable} />
          <StepCard
            step={step}
            index={index}
            count={pipeline.steps.length}
            definition={byType.get(step.type)}
            issues={issues.filter((i) => issuePlace(i.path).step === index)}
            onEdit={onEdit}
            editable={editable}
            credentials={credentials}
            picker={picker}
            tryHere={tryHere}
            marked={marked?.has(step.id) ?? false}
            inApp={Boolean(pipeline.app)}
          />
        </div>
      ))}
      {pipeline.steps.length === 0 && (
        <div className="text-center text-secondary" data-testid="no-steps">
          No steps yet. A step does one thing (fetch email, ask the LLM, save to an App, send me a message); add the first from the catalog.
        </div>
      )}
      <AddHere onAdd={() => setAdding(pipeline.steps.length - 1)} disabled={!editable} last />
      {adding !== null && (
        <StepPicker
          catalog={catalog}
          onClose={() => setAdding(null)}
          onPick={(type) => {
            onEdit((s) => addStep(s, type, adding < 0 ? -1 : adding));
            setAdding(null);
          }}
        />
      )}
    </div>
  );
}

/** M38-T5: a mark on what the builder's proposal changed. */
function BuilderMark({ what }: Readonly<{ what: string }>) {
  return (
    <div className="badge bg-azure-lt text-azure align-self-start m-2 mb-0" data-testid="builder-mark">
      {what} changed by the builder
    </div>
  );
}

function AddHere({ onAdd, disabled, last }: Readonly<{ onAdd: () => void; disabled: boolean; last?: boolean }>) {
  if (disabled) return null;
  return (
    <div className={`text-center ${last ? "" : "mb-2"}`}>
      <button type="button" className="btn btn-sm btn-ghost-primary" onClick={onAdd} data-testid={last ? "add-step" : "add-step-here"}>
        <IconPlus size={16} className="me-1" />
        {last ? "Add a step" : "Add a step here"}
      </button>
    </div>
  );
}

/** The catalog by category, with a search: a step's type and what it does. */
function StepPicker({
  catalog,
  onPick,
  onClose,
}: Readonly<{ catalog: StepTypeView[]; onPick: (type: string) => void; onClose: () => void }>) {
  const [query, setQuery] = useState("");
  const shown = catalog.filter((s) => `${s.type} ${s.description}`.toLowerCase().includes(query.toLowerCase()));
  const categories = [...new Set(shown.map((s) => s.category))].sort();
  return (
    <Modal title="Add a step" size="lg" onClose={onClose}>
      <div className="input-icon mb-3">
        <span className="input-icon-addon">
          <IconSearch size={16} />
        </span>
        <input
          className="form-control"
          placeholder="email, save, telegram…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
          aria-label="Find a step"
          title={HELP.stepSearch}
          data-testid="step-search"
        />
      </div>
      <div className="d-flex flex-column gap-3" style={{ maxHeight: "60vh", overflowY: "auto" }}>
        {categories.map((category) => (
          <div key={category}>
            <div className="text-uppercase text-secondary small fw-bold mb-1">{category}</div>
            <div className="list-group">
              {shown
                .filter((s) => s.category === category)
                .map((s) => (
                  <button
                    key={s.type}
                    type="button"
                    className="list-group-item list-group-item-action"
                    onClick={() => onPick(s.type)}
                    data-testid="pick-step"
                    data-type={s.type}
                  >
                    <div className="d-flex align-items-center gap-2">
                      <code>{s.type}</code>
                      {s.sideEffect && <span className="badge bg-orange-lt">side effect: behind a gate</span>}
                      {s.llmOutput && <span className="badge bg-purple-lt">LLM</span>}
                    </div>
                    <div className="text-secondary small">{s.description}</div>
                  </button>
                ))}
            </div>
          </div>
        ))}
        {categories.length === 0 && <div className="text-secondary">No step does that.</div>}
      </div>
    </Modal>
  );
}

function StepCard({
  step,
  index,
  count,
  definition,
  issues,
  onEdit,
  editable,
  credentials,
  picker,
  tryHere,
  marked,
  inApp,
}: Readonly<{
  step: LooseStep;
  index: number;
  count: number;
  definition: StepTypeView | undefined;
  issues: CompileIssue[];
  onEdit: (edit: DesignerEdit) => void;
  editable: boolean;
  credentials: CredentialView[];
  picker?: (step: number, input: string, kind: "whole" | "insert", onPick: (reference: string) => void) => ReactNode;
  tryHere?: (step: LooseStep) => ReactNode;
  marked: boolean;
  /** The pipeline belongs to an App: a data step's `type` (one of its types) is shown up front. */
  inApp: boolean;
}>) {
  const [more, setMore] = useState(false);
  const properties = definition?.input.properties ?? {};
  const required = new Set(definition?.input.required ?? []);
  const names = Object.keys(properties);
  const set = (field: string, value: unknown) => onEdit((s) => setStepInput(s, index, field, value));
  // Shown: what it needs, what is nearly always given (http.fetch's url) and what is set; the rest under "More".
  const primary = new Set([...(definition?.primary ?? []), ...(inApp && step.type.startsWith("data.") ? ["type"] : [])]);
  const main = names.filter((n) => required.has(n) || primary.has(n) || step.with[n] !== undefined);
  const rest = names.filter((n) => !main.includes(n));
  const unknown = Object.keys(step.with).filter((n) => !(n in properties));
  const inputIssues = (field: string) => issues.filter((i) => issuePlace(i.path).input === field);
  const stepIssues = issues.filter((i) => !issuePlace(i.path).input || !names.includes(issuePlace(i.path).input!));
  const takesCredential = (field: string) =>
    definition?.credentials === true || (Array.isArray(definition?.credentials) && definition.credentials.includes(field));

  const field = (name: string) => {
    const schema = properties[name];
    const kind = resolve(schema).type === "string" ? "insert" : "whole";
    return (
      <div key={name}>
        <SchemaField
          name={name}
          schema={schema}
          value={step.with[name]}
          required={required.has(name)}
          onChange={(v) => set(name, v)}
          disabled={!editable}
          testId={`input-${name}`}
          extra={
            <>
              {editable &&
                picker?.(index, name, kind, (reference) =>
                  set(name, kind === "insert" && typeof step.with[name] === "string" ? `${step.with[name]}${reference}` : reference),
                )}
              {editable && takesCredential(name) && credentials.length > 0 && (
                <select
                  className="form-select form-select-sm w-auto py-0"
                  value=""
                  onChange={(e) => e.target.value && set(name, `{{cred:${e.target.value}}}`)}
                  title={HELP.stepCredential}
                  aria-label={`A credential for ${name}`}
                >
                  <option value="">a credential…</option>
                  {credentials.map((c) => (
                    <option key={c.credentialId} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
              )}
            </>
          }
        />
        {inputIssues(name).map((i) => (
          <div key={i.path + i.message} className="text-danger small mt-n1 mb-2" data-testid="card-issue">
            {i.path.replace(/^steps\[\d+\]\.with\./, "")}: {i.message}
            <AllowSite message={i.message} onEdit={onEdit} editable={editable} />
          </div>
        ))}
      </div>
    );
  };

  return (
    <div
      className={`card ${issues.length ? "border-danger" : marked ? "border-azure" : ""}`}
      style={marked ? { borderWidth: 2 } : undefined}
      data-testid="step-card"
      data-step={step.id}
      data-marked={marked || undefined}
    >
      {marked && <BuilderMark what="This step" />}
      <div className="card-header gap-2 flex-wrap">
        <span className="badge bg-secondary-lt">{index + 1}</span>
        <CommitInput
          value={step.id}
          className="form-control form-control-sm font-monospace w-auto"
          valid={(v) => STEP_ID.test(v)}
          onCommit={(to) => onEdit((s) => renameStep(s, index, to))}
          disabled={!editable}
          ariaLabel={`Step ${step.id}'s id`}
          help={HELP.stepId}
          testId="step-id"
        />
        <code className="text-secondary">{step.type}</code>
        {definition?.sideEffect && <span className="badge bg-orange-lt">side effect: behind a gate</span>}
        {definition?.llmOutput && <span className="badge bg-purple-lt">LLM</span>}
        {!definition && <span className="badge bg-red-lt">not in the catalog</span>}
        {editable && (
          <div className="ms-auto btn-list">
            <button
              type="button"
              className="btn btn-icon btn-sm btn-ghost-secondary"
              disabled={index === 0}
              onClick={() => onEdit((s) => moveStep(s, index, -1))}
              aria-label="Move up"
            >
              <IconArrowUp size={16} />
            </button>
            <button
              type="button"
              className="btn btn-icon btn-sm btn-ghost-secondary"
              disabled={index === count - 1}
              onClick={() => onEdit((s) => moveStep(s, index, 1))}
              aria-label="Move down"
            >
              <IconArrowDown size={16} />
            </button>
            <button
              type="button"
              className="btn btn-icon btn-sm btn-ghost-danger"
              disabled={count === 1}
              onClick={() => onEdit((s) => removeStep(s, index))}
              aria-label={`Remove ${step.id}`}
              data-testid="remove-step"
            >
              <IconTrash size={16} />
            </button>
          </div>
        )}
      </div>
      <div className="card-body">
        {definition && <div className="text-secondary small mb-2">{definition.description}</div>}
        {stepIssues.map((i) => (
          <div key={i.path + i.message} className="text-danger small mb-2 d-flex gap-1" data-testid="card-issue">
            <IconAlertTriangle size={16} />
            {i.message}
            <AllowSite message={i.message} onEdit={onEdit} editable={editable} />
          </div>
        ))}
        <StepOptions step={step} index={index} onEdit={onEdit} editable={editable} picker={picker} />
        {main.map(field)}
        {unknown.map((name) => (
          <div key={name}>
            <SchemaField
              name={name}
              schema={{}}
              value={step.with[name]}
              required={false}
              onChange={(v) => set(name, v)}
              disabled={!editable}
            />
            <div className="text-warning small mt-n1 mb-2">Not an input of {step.type}.</div>
          </div>
        ))}
        {rest.length > 0 && (
          <>
            <button type="button" className="btn btn-link btn-sm p-0" onClick={() => setMore(!more)} data-testid="more-inputs">
              {more ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
              {more ? "Fewer" : `More (${rest.length})`}: {rest.join(", ")}
            </button>
            {more && <div className="mt-2">{rest.map(field)}</div>}
          </>
        )}
      </div>
      {tryHere && step.id && <div className="card-footer py-2">{tryHere(step)}</div>}
    </div>
  );
}

/** when, forEach and retries: what runs the step, and how often. */
function StepOptions({
  step,
  index,
  onEdit,
  editable,
  picker,
}: Readonly<{
  step: LooseStep;
  index: number;
  onEdit: (edit: DesignerEdit) => void;
  editable: boolean;
  picker?: (step: number, input: string, kind: "whole" | "insert", onPick: (reference: string) => void) => ReactNode;
}>) {
  const [open, setOpen] = useState(step.when !== undefined || step.forEach !== undefined);
  const reference = (v: string) => v === "" || /^\{\{\s*[^{}]+?\s*\}\}$/.test(v);
  const row = (option: "when" | "forEach", label: string) => (
    <div className="d-flex gap-2 align-items-center mb-2 small">
      <span className="text-nowrap" style={{ width: 110 }}>
        {label}
      </span>
      <CommitInput
        value={step[option] ?? ""}
        className="form-control form-control-sm font-monospace"
        placeholder={option === "when" ? "{{save.added}}: only when there is something" : "{{search.items}}: once for each, as {{item}}"}
        valid={reference}
        onCommit={(v) => onEdit((s) => setStepOption(s, index, option, v || undefined))}
        disabled={!editable}
        ariaLabel={`${step.id}'s ${option}`}
        help={option === "when" ? HELP.stepWhen : HELP.stepForEach}
        testId={`step-${option}`}
      />
      {editable && picker?.(index, `:${option}`, "whole", (r) => onEdit((s) => setStepOption(s, index, option, r)))}
    </div>
  );
  if (!open)
    return (
      <button type="button" className="btn btn-link btn-sm p-0 mb-2" onClick={() => setOpen(true)} data-testid="step-options">
        Only when…, for each…
      </button>
    );
  return (
    <div className="border-bottom pb-1 mb-2">
      {row("when", "only when")}
      {row("forEach", "for each of")}
    </div>
  );
}

/** A site a step reads that the pipeline may not: allowed from the card, no YAML needed. */
function AllowSite({ message, onEdit, editable }: Readonly<{ message: string; onEdit: (edit: DesignerEdit) => void; editable: boolean }>) {
  const host = notAllowedHost(message);
  if (!host || !editable) return null;
  return (
    <button
      type="button"
      className="btn btn-sm btn-outline-primary ms-2 py-0"
      onClick={() => onEdit((s) => allowDomain(s, host))}
      title={`Let this pipeline read from ${host} (its policy's allowedDomains)`}
      data-testid="allow-site"
    >
      <IconWorld size={14} className="me-1" />
      Allow {host}
    </button>
  );
}

/** The sites the pipeline may read (policy.allowedDomains), each removable. */
function AllowedSites({ source, onEdit, editable }: Readonly<{ source: string; onEdit: (edit: DesignerEdit) => void; editable: boolean }>) {
  const sites = allowedDomainsOf(source);
  if (sites.length === 0) return null;
  return (
    <div className="d-flex flex-wrap align-items-center gap-1 small" data-testid="allowed-sites">
      <span className="text-secondary me-1" title={HELP.allowedSites}>
        <IconWorld size={14} className="me-1" />
        Sites it may read:
      </span>
      {sites.map((site) => (
        <span key={site} className="badge bg-secondary-lt d-inline-flex align-items-center gap-1" data-testid="allowed-site">
          {site}
          {editable && (
            <button
              type="button"
              className="btn btn-link p-0 text-secondary"
              aria-label={`Stop reading ${site}`}
              onClick={() => onEdit((s) => allowDomain(s, site, false))}
            >
              <IconX size={12} />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}

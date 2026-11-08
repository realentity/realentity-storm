import { type CompiledDefinition, type CompiledPolicy, type CompileIssue, type DefinitionChange, type StepTypeView } from "@realentity/storm-shared";
import { IconArrowRight, IconShieldCheck } from "@tabler/icons-react";
import { Fragment, useMemo } from "react";
import { dependencies, describeChange, describeTrigger, policySummary, stepGraph } from "../lib/plan";
import { Json } from "./ui";

interface PlanProps {
  definition: CompiledDefinition;
  policy: CompiledPolicy;
  catalog: readonly StepTypeView[];
}

/** Readable plan (docs/design.md §2.1): what triggers it, each step in order, and what the policy lets it do. */
export function PlanView({ definition, policy, catalog }: PlanProps) {
  const byType = useMemo(() => new Map(catalog.map((s) => [s.type, s])), [catalog]);
  const ids = useMemo(() => new Set(definition.steps.map((s) => s.id)), [definition]);
  return (
    <div className="d-flex flex-column gap-3">
      <div>
        <div className="fw-bold">{definition.name}</div>
        {definition.description && <div className="text-secondary">{definition.description}</div>}
        <div className="text-secondary small">{describeTrigger(definition.trigger)}</div>
      </div>

      <div className="card card-sm">
        <div className="card-header">
          <IconShieldCheck size={18} className="me-2 text-green" />
          <h3 className="card-title">What it may do</h3>
        </div>
        <ul className="list-group list-group-flush" data-testid="policy-summary">
          {policySummary(definition, policy, catalog).map((line) => (
            <li key={line} className="list-group-item">
              {line}
            </li>
          ))}
        </ul>
      </div>

      <div className="table-responsive">
        <table className="table table-vcenter card-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Step</th>
              <th>Does</th>
              <th>Input</th>
            </tr>
          </thead>
          <tbody>
            {definition.steps.map((step, index) => {
              const type = byType.get(step.type);
              const reads = dependencies(step, ids);
              return (
                <tr key={step.id}>
                  <td className="text-secondary">{index + 1}</td>
                  <td>
                    <div className="fw-bold">{step.id}</div>
                    <code className="small">{step.type}</code>
                    <div className="d-flex gap-1 mt-1 flex-wrap">
                      {type?.sideEffect && <span className="badge bg-red-lt">side effect</span>}
                      {step.type.startsWith("gate.") && <span className="badge bg-yellow-lt">waits for you</span>}
                      {step.autoInserted && <span className="badge bg-azure-lt">added by the compiler</span>}
                      {step.forEach && <span className="badge bg-secondary-lt">for each {step.forEach}</span>}
                      {step.when && <span className="badge bg-secondary-lt">only when {step.when} isn't empty</span>}
                    </div>
                  </td>
                  <td className="text-secondary">
                    {type?.description ?? "Unknown step type"}
                    {reads.length > 0 && <div className="small">reads {reads.join(", ")}</div>}
                  </td>
                  <td style={{ minWidth: 220 }}>
                    <Json value={step.with} maxHeight={160} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The step graph by data flow: columns left to right, each node lists what it reads from. */
export function StepGraphView({ definition, catalog }: { definition: CompiledDefinition; catalog: readonly StepTypeView[] }) {
  const graph = useMemo(() => stepGraph(definition), [definition]);
  const steps = useMemo(() => new Map(definition.steps.map((s) => [s.id, s])), [definition]);
  const sideEffects = useMemo(() => new Set(catalog.filter((s) => s.sideEffect).map((s) => s.type)), [catalog]);
  return (
    <div className="step-graph" data-testid="step-graph">
      {graph.layers.map((layer, index) => (
        <Fragment key={layer.join()}>
          {index > 0 && <IconArrowRight className="step-graph-arrow" size={20} />}
          <div className="step-graph-layer">
            {layer.map((id) => {
              const step = steps.get(id)!;
              const tone = sideEffects.has(step.type) ? "red" : step.type.startsWith("gate.") ? "yellow" : "secondary";
              const from = graph.edges.filter((e) => e.to === id).map((e) => e.from);
              return (
                <div key={id} className={`step-graph-node border-${tone}`}>
                  <div className="fw-bold">{id}</div>
                  <code className="small">{step.type}</code>
                  {step.forEach && <div className="small text-secondary">× each item</div>}
                  {from.length > 0 && <div className="small text-secondary">← {from.join(", ")}</div>}
                </div>
              );
            })}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

export function DiffList({ changes, against }: { changes: DefinitionChange[]; against: number }) {
  return (
    <div className="card card-sm" data-testid="version-diff">
      <div className="card-header">
        <h3 className="card-title">Changes against v{against}</h3>
      </div>
      {changes.length === 0 ? (
        <div className="card-body text-secondary">No changes.</div>
      ) : (
        <ul className="list-group list-group-flush">
          {changes.map((change) => (
            <li key={describeChange(change)} className="list-group-item">
              <span className={`badge me-2 ${changeTone(change)}`}>{change.kind.replace("step-", "")}</span>
              {describeChange(change)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function changeTone(change: DefinitionChange): string {
  if (change.kind === "step-added") return "bg-green-lt";
  if (change.kind === "step-removed") return "bg-red-lt";
  return "bg-blue-lt";
}

export function CompileErrors({ errors, title = "The pipeline doesn't compile" }: { errors: CompileIssue[]; title?: string }) {
  return (
    <div className="alert alert-danger" data-testid="compile-errors">
      <div className="fw-bold mb-1">{title}</div>
      <ul className="mb-0">
        {errors.map((e) => (
          <li key={`${e.path}:${e.message}`}>
            <code>{e.path || "(root)"}</code> {e.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

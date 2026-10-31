import { canonicalJson, type CompiledDefinition, type CompiledStep, type DefinitionChange, type DefinitionDiff } from "@ai-me/shared";

export type { DefinitionChange, DefinitionDiff };

/** What changed between two compiled versions of a pipeline (v3 → v4). */
export function diffDefinitions(before: CompiledDefinition, after: CompiledDefinition): DefinitionDiff {
  const changes: DefinitionChange[] = [];

  for (const field of ["name", "description", "trigger"] as const) {
    if (!same(before[field], after[field])) changes.push({ kind: "pipeline", field, before: before[field], after: after[field] });
  }

  for (const stepType of unionKeys(before.limits, after.limits)) {
    const b = before.limits[stepType];
    const a = after.limits[stepType];
    if (b !== a) changes.push({ kind: "limit", stepType, before: b, after: a });
  }

  for (const list of ["allowedDomains", "allowedRecipients"] as const) {
    const b = new Set(before.policy[list]);
    const a = new Set(after.policy[list]);
    const added = [...a].filter((x) => !b.has(x));
    const removed = [...b].filter((x) => !a.has(x));
    if (added.length || removed.length) changes.push({ kind: "policy", list, added, removed });
  }

  const beforeSteps = new Map(before.steps.map((s, i) => [s.id, { step: s, index: i }]));
  const afterSteps = new Map(after.steps.map((s, i) => [s.id, { step: s, index: i }]));

  for (const [id, { step }] of beforeSteps) {
    if (!afterSteps.has(id)) changes.push({ kind: "step-removed", stepId: id, type: step.type, autoInserted: !!step.autoInserted });
  }
  for (const [id, { step }] of afterSteps) {
    if (!beforeSteps.has(id)) changes.push({ kind: "step-added", stepId: id, type: step.type, autoInserted: !!step.autoInserted });
  }

  // Order among the steps both versions share.
  const keptBefore = before.steps.filter((s) => afterSteps.has(s.id)).map((s) => s.id);
  const keptAfter = after.steps.filter((s) => beforeSteps.has(s.id)).map((s) => s.id);
  keptAfter.forEach((id, to) => {
    const from = keptBefore.indexOf(id);
    if (from !== to) changes.push({ kind: "step-moved", stepId: id, from, to });
  });

  for (const [id, { step: a }] of afterSteps) {
    const b = beforeSteps.get(id)?.step;
    if (b) changes.push(...stepChanges(b, a));
  }

  return { changes, summary: changes.map(describe).join("\n") };
}

function stepChanges(before: CompiledStep, after: CompiledStep): DefinitionChange[] {
  const changes: DefinitionChange[] = [];
  for (const field of ["type", "forEach", "retries"] as const) {
    if (!same(before[field], after[field]))
      changes.push({ kind: "step-changed", stepId: after.id, field, before: before[field], after: after[field] });
  }
  for (const key of unionKeys(before.with, after.with)) {
    if (!same(before.with[key], after.with[key])) {
      changes.push({ kind: "step-changed", stepId: after.id, field: `with.${key}`, before: before.with[key], after: after.with[key] });
    }
  }
  return changes;
}

function describe(change: DefinitionChange): string {
  switch (change.kind) {
    case "pipeline":
      return `${change.field}: ${show(change.before)} → ${show(change.after)}`;
    case "limit":
      return change.before === undefined
        ? `limit ${change.stepType}: added ${change.after}`
        : change.after === undefined
          ? `limit ${change.stepType}: removed (was ${change.before})`
          : `limit ${change.stepType}: ${change.before} → ${change.after}`;
    case "policy":
      return [
        change.added.length ? `${change.list}: added ${change.added.join(", ")}` : "",
        change.removed.length ? `${change.list}: removed ${change.removed.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
    case "step-added":
      return `step ${change.stepId} (${change.type}) added${change.autoInserted ? " automatically" : ""}`;
    case "step-removed":
      return `step ${change.stepId} (${change.type}) removed`;
    case "step-moved":
      return `step ${change.stepId} moved`;
    case "step-changed":
      return `step ${change.stepId}: ${change.field} ${show(change.before)} → ${show(change.after)}`;
  }
}

function show(value: unknown): string {
  if (value === undefined) return "(none)";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** Deep equality for JSON values; object key order doesn't matter. */
function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function unionKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])];
}

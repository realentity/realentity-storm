import {
  REFERENCE,
  type CompiledDefinition,
  type CompiledPolicy,
  type CompiledStep,
  type DefinitionChange,
  type StepTypeView,
  type Trigger,
} from "@ai-me/shared";

/** Step ids a step reads from: {{step.field}} in its inputs or forEach, and the step a gate.act is for. */
export function dependencies(step: CompiledStep, stepIds: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  const scan = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(REFERENCE)) {
        const head = match[1]?.trim().split(".")[0] ?? "";
        if (stepIds.has(head)) found.add(head);
      }
    } else if (Array.isArray(value)) value.forEach(scan);
    else if (value && typeof value === "object") Object.values(value).forEach(scan);
  };
  scan(step.with);
  if (step.forEach) scan(step.forEach);
  if (step.type === "gate.act" && typeof step.with.for === "string" && stepIds.has(step.with.for)) found.add(step.with.for);
  found.delete(step.id);
  return [...found];
}

export interface StepGraph {
  /** Columns left to right: a step sits one column after the last step it reads from. */
  layers: string[][];
  edges: { from: string; to: string }[];
}

/**
 * A step graph by data flow. Steps run in order, so a step only reads from earlier ones; a gate.act points at the
 * later step it guards (drawn as gate → step).
 */
export function stepGraph(definition: CompiledDefinition): StepGraph {
  const ids = new Set(definition.steps.map((s) => s.id));
  const level = new Map<string, number>();
  const edges: StepGraph["edges"] = [];
  for (const step of definition.steps) {
    const deps = dependencies(step, ids).filter((id) => level.has(id));
    for (const from of deps) edges.push({ from, to: step.id });
    level.set(step.id, deps.length === 0 ? 0 : Math.max(...deps.map((id) => level.get(id)!)) + 1);
  }
  // gate.act → the side-effect step it guards: the guarded step goes after its gate.
  for (const step of definition.steps) {
    const target = step.type === "gate.act" ? step.with.for : undefined;
    if (typeof target !== "string" || !level.has(target)) continue;
    edges.push({ from: step.id, to: target });
    level.set(target, Math.max(level.get(target)!, level.get(step.id)! + 1));
  }
  const layers: string[][] = [];
  for (const step of definition.steps) (layers[level.get(step.id)!] ??= []).push(step.id);
  return { layers: layers.filter((layer) => layer.length > 0), edges };
}

export function describeTrigger(trigger: Trigger): string {
  if (trigger === "manual") return "Manual: runs when I start it";
  if ("schedule" in trigger) return `On schedule ${trigger.schedule} (${trigger.tz})`;
  if ("webhook" in trigger) return `On a webhook call (${trigger.webhook === "token" ? "bearer token" : "HMAC-SHA256 signature"})`;
  switch (trigger.on) {
    case "run.finished":
      return `When "${trigger.pipeline}" finishes ${(trigger.status ?? ["DONE"]).join(" or ")}`;
    case "application.status":
      return `When an application becomes ${trigger.status?.join(" or ") ?? "anything new"}`;
    case "recipe.broken":
      return `When a recipe${trigger.site ? ` of ${trigger.site}` : ""} breaks`;
    case "email.classified":
      return `When an email is labelled ${trigger.label?.join(" or ") ?? "(any label)"}`;
    case "flow.later":
      return "Started later by another pipeline (flow.later), with its data";
  }
}

/** What the review screen says about what a pipeline may do (README §2.2 "Policy"). */
export function policySummary(definition: CompiledDefinition, policy: CompiledPolicy, catalog: readonly StepTypeView[]): string[] {
  const byType = new Map(catalog.map((s) => [s.type, s]));
  const sideEffects = definition.steps.filter((s) => byType.get(s.type)?.sideEffect);
  const lines: string[] = [];
  if (sideEffects.length === 0) {
    lines.push("No side effects: nothing is sent, submitted or uploaded outside AI ME.");
  } else {
    for (const step of sideEffects) {
      const gate = definition.steps.find((s) => s.type === "gate.act" && s.with.for === step.id);
      lines.push(
        `${step.id} (${step.type}) acts outside AI ME${step.forEach ? ", once per item" : ""}; it waits for my approval at ${gate?.id ?? "a gate"}.`,
      );
    }
  }
  if (policy.allowedRecipients.length > 0) lines.push(`Allowed recipients: ${policy.allowedRecipients.join(", ")}`);
  if (policy.allowedDomains.length > 0) lines.push(`Allowed domains: ${policy.allowedDomains.join(", ")}`);
  for (const rule of policy.provenance) {
    lines.push(`${rule.stepId}.${rule.field} (${rule.kind}) must come from {{${rule.source}}}, never from LLM text.`);
  }
  for (const [type, limit] of Object.entries(definition.limits)) lines.push(`At most ${limit} for ${type}`);
  if (definition.steps.some((s) => byType.get(s.type)?.headed)) lines.push("Uses the headed browser: one such run at a time.");
  return lines;
}

/** One readable line per change (the review screen's diff). */
export function describeChange(change: DefinitionChange): string {
  switch (change.kind) {
    case "pipeline":
      return `${change.field}: ${show(change.before)} → ${show(change.after)}`;
    case "limit":
      return `limit ${change.stepType}: ${change.before ?? "none"} → ${change.after ?? "none"}`;
    case "policy":
      return [
        change.added.length ? `${change.list} + ${change.added.join(", ")}` : "",
        change.removed.length ? `${change.list} − ${change.removed.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
    case "step-added":
      return `added step ${change.stepId} (${change.type})${change.autoInserted ? ", inserted by the compiler" : ""}`;
    case "step-removed":
      return `removed step ${change.stepId} (${change.type})`;
    case "step-moved":
      return `moved step ${change.stepId}: position ${change.from + 1} → ${change.to + 1}`;
    case "step-changed":
      return `step ${change.stepId} ${change.field}: ${show(change.before)} → ${show(change.after)}`;
  }
}

function show(value: unknown): string {
  if (value === undefined) return "(none)";
  return typeof value === "string" ? `"${value}"` : JSON.stringify(value);
}

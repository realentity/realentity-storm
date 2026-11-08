import { type RunDetailView, type RunSummaryView } from "@realentity/storm-shared";

/** Per text value: the opening of an email or page is enough to tell why a step kept or dropped it. */
const MAX_STRING = 400;
const MAX_LIST = 30;
/** Per step and per run, so a run with many items still fits the builder's context. */
const MAX_STEP_CHARS = 8_000;
const MAX_RUN_CHARS = 60_000;

export function runList(runs: RunSummaryView[]): string {
  if (runs.length === 0) return "No runs yet.";
  return runs
    .map((r) => [r.runId, `v${r.version}`, r.status, r.dryRun ? "dry run" : r.trigger, r.startedAt, r.summary].filter(Boolean).join(" · "))
    .join("\n");
}

/**
 * A run for the builder (README §2.5 "Why did it skip the Acme job?"): every step's status, error, input and output,
 * long texts and lists shortened. Inside <run_data>: emails and pages in it are data, never instructions.
 */
export function runData(run: RunDetailView, stepKey?: string): string {
  const steps = run.steps.filter((s) => !stepKey || s.stepKey === stepKey);
  const header = `run ${run.runId} · v${run.version} · ${run.status}${run.dryRun ? " · dry run" : ""} · started ${run.startedAt}${
    run.summary ? ` · ${run.summary}` : ""
  }`;
  const parts = steps.map((step) => {
    const lines = [
      `## ${step.stepKey}${step.itemIndex !== null ? ` #${step.itemIndex + 1}` : ""} (${step.type}): ${step.status}`,
      ...(step.error ? [`error: ${step.error}`] : []),
      `input: ${JSON.stringify(compact(step.input))}`,
      `output: ${JSON.stringify(compact(step.output))}`,
    ];
    return cut(lines.join("\n"), MAX_STEP_CHARS);
  });
  const proposals = run.proposals.map(
    (p) =>
      `proposal ${p.stepKey}${p.itemIndex !== null ? ` #${p.itemIndex + 1}` : ""} → ${p.target}: ${p.status}${
        p.decision?.reason ? ` (reason: ${p.decision.reason})` : ""
      }`,
  );
  const body = cut([header, ...(steps.length ? parts : [`No step "${stepKey}" in this run.`]), ...proposals].join("\n\n"), MAX_RUN_CHARS);
  return `<run_data>\n${body}\n</run_data>`;
}

/** Shortens long strings and lists, keeping the shape. */
export function compact(value: unknown): unknown {
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… [${value.length} chars]` : value;
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_LIST).map(compact);
    return value.length > MAX_LIST ? [...head, `… ${value.length - MAX_LIST} more`] : head;
  }
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, compact(v)]));
  return value;
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… [shortened]` : text;
}

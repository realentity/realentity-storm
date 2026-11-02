import { type CostsView, type ModelChoiceView, type RunCostView } from "@ai-me/shared";
import { formatUsd } from "./format";

/** What the Costs page shows: one pipeline or all, with or without dry runs. */
export interface CostFilter {
  pipelineId: string | null;
  dryRuns: boolean;
}

/** One step of a pipeline across its runs: forEach items and retries add up into it. */
export interface StepCost {
  stepKey: string;
  type: string;
  /** Every model that answered, in order of first use. */
  models: string[];
  /** Runs in which the step called the LLM. */
  runs: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** Of the pipeline's cost. */
  share: number;
}

export interface PipelineCost {
  pipelineId: string;
  pipelineName: string;
  runs: number;
  dryRuns: number;
  /** Runs that called the LLM at all. */
  paidRuns: number;
  costUsd: number;
  perRunUsd: number;
  maxRunUsd: number;
  calls: number;
  /** The most expensive first. */
  steps: StepCost[];
}

export interface CostTotals {
  runs: number;
  dryRuns: number;
  paidRuns: number;
  calls: number;
  costUsd: number;
  perRunUsd: number;
}

export function filterRuns(runs: RunCostView[], filter: CostFilter): RunCostView[] {
  return runs.filter((run) => (filter.dryRuns || !run.dryRun) && (!filter.pipelineId || run.pipelineId === filter.pipelineId));
}

export function totals(runs: RunCostView[]): CostTotals {
  const costUsd = round(runs.reduce((sum, run) => sum + run.costUsd, 0));
  return {
    runs: runs.length,
    dryRuns: runs.filter((run) => run.dryRun).length,
    paidRuns: runs.filter((run) => run.costUsd > 0).length,
    calls: runs.reduce((sum, run) => sum + run.steps.reduce((n, s) => n + s.calls, 0), 0),
    costUsd,
    perRunUsd: runs.length ? round(costUsd / runs.length) : 0,
  };
}

/** Per pipeline, the most expensive first; each with its steps, the most expensive first. */
export function byPipeline(runs: RunCostView[]): PipelineCost[] {
  const pipelines = new Map<string, { name: string; runs: RunCostView[] }>();
  for (const run of runs) {
    const entry = pipelines.get(run.pipelineId) ?? { name: run.pipelineName, runs: [] };
    entry.runs.push(run);
    pipelines.set(run.pipelineId, entry);
  }
  return [...pipelines.entries()]
    .map(([pipelineId, { name, runs: own }]) => {
      const sum = totals(own);
      return {
        pipelineId,
        pipelineName: name,
        runs: sum.runs,
        dryRuns: sum.dryRuns,
        paidRuns: sum.paidRuns,
        costUsd: sum.costUsd,
        perRunUsd: sum.perRunUsd,
        maxRunUsd: Math.max(0, ...own.map((run) => run.costUsd)),
        calls: sum.calls,
        steps: stepCosts(own, sum.costUsd),
      };
    })
    .sort((a, b) => b.costUsd - a.costUsd || a.pipelineName.localeCompare(b.pipelineName));
}

function stepCosts(runs: RunCostView[], pipelineUsd: number): StepCost[] {
  const steps = new Map<string, StepCost & { runIds: Set<string> }>();
  for (const run of runs) {
    for (const step of run.steps) {
      const key = `${step.stepKey}\u0000${step.type}`;
      const into = steps.get(key) ?? {
        stepKey: step.stepKey,
        type: step.type,
        models: [],
        runs: 0,
        runIds: new Set<string>(),
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        share: 0,
      };
      into.models = [...new Set([...into.models, ...step.models])];
      into.runIds.add(run.runId);
      into.calls += step.calls;
      into.inputTokens += step.inputTokens;
      into.outputTokens += step.outputTokens;
      into.cacheReadTokens += step.cacheReadTokens;
      into.cacheWriteTokens += step.cacheWriteTokens;
      into.costUsd += step.costUsd;
      steps.set(key, into);
    }
  }
  return [...steps.values()]
    .map(({ runIds, ...step }) => ({
      ...step,
      runs: runIds.size,
      costUsd: round(step.costUsd),
      share: pipelineUsd > 0 ? step.costUsd / pipelineUsd : 0,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || a.stepKey.localeCompare(b.stepKey));
}

/** "850", "12.3K", "1.2M". */
export function formatTokens(count: number): string {
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}K`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

const perCall = (tokens: number, calls: number): string => (calls ? formatTokens(tokens / calls) : "—");

/**
 * The page as Markdown, to paste into a chat about cutting costs: totals, each pipeline's steps with tokens per call,
 * the most expensive runs, and the model each task uses.
 */
export function costReport(
  view: CostsView,
  runs: RunCostView[],
  filter: CostFilter,
  models?: Record<string, ModelChoiceView>,
): string {
  const sum = totals(runs);
  const pipelines = byPipeline(runs);
  const lines: string[] = [];
  const row = (cells: (string | number)[]) => lines.push(`| ${cells.join(" | ")} |`);
  const head = (cells: string[]) => {
    row(cells);
    row(cells.map(() => "---"));
  };

  lines.push(`# AI ME LLM costs: last ${view.days} days (since ${view.since.slice(0, 10)})`, "");
  const scope = [
    filter.pipelineId ? `pipeline: ${pipelines[0]?.pipelineName ?? filter.pipelineId}` : "all pipelines",
    filter.dryRuns ? "dry runs included" : "dry runs left out",
  ];
  lines.push(`Scope: ${scope.join(", ")}${view.truncated ? `; only the newest ${view.limit} runs` : ""}.`);
  lines.push(
    `Runs: ${sum.runs} (${sum.dryRuns} dry, ${sum.paidRuns} called the LLM) · LLM calls: ${sum.calls} · total ${formatUsd(sum.costUsd)} · ${formatUsd(sum.perRunUsd)} per run`,
    "",
  );

  lines.push("## By pipeline", "");
  head(["Pipeline", "Runs", "Total", "Per run", "Most expensive run", "LLM calls"]);
  for (const p of pipelines) row([p.pipelineName, p.runs, formatUsd(p.costUsd), formatUsd(p.perRunUsd), formatUsd(p.maxRunUsd), p.calls]);
  lines.push("");

  lines.push("## Steps per pipeline", "", "Tokens are averages per LLM call; cost per run is over all the pipeline's runs.", "");
  for (const p of pipelines.filter((p) => p.steps.length > 0)) {
    lines.push(`### ${p.pipelineName}: ${p.runs} runs, ${formatUsd(p.costUsd)}, ${formatUsd(p.perRunUsd)} per run`, "");
    head(["Step", "Type", "Model", "Calls per run", "Input", "Output", "Cache read", "Cache write", "Per run", "Share"]);
    for (const s of p.steps) {
      row([
        s.stepKey,
        s.type,
        s.models.join(" + ") || "?",
        (s.calls / p.runs).toFixed(1),
        perCall(s.inputTokens, s.calls),
        perCall(s.outputTokens, s.calls),
        perCall(s.cacheReadTokens, s.calls),
        perCall(s.cacheWriteTokens, s.calls),
        formatUsd(round(s.costUsd / p.runs)),
        `${Math.round(s.share * 100)}%`,
      ]);
    }
    lines.push("");
  }

  const top = [...runs].filter((run) => run.costUsd > 0).sort((a, b) => b.costUsd - a.costUsd).slice(0, 10);
  if (top.length) {
    lines.push("## Most expensive runs", "");
    head(["Started", "Pipeline", "Trigger", "Cost", "Steps"]);
    for (const run of top) {
      const steps = run.steps
        .map((s) => `${s.stepKey}${s.itemIndex === null ? "" : `[${s.itemIndex}]`} ${formatUsd(s.costUsd)} (${formatTokens(s.inputTokens)} in / ${formatTokens(s.outputTokens)} out)`)
        .join(", ");
      row([run.startedAt.slice(0, 16).replace("T", " "), `${run.pipelineName} v${run.version}`, run.dryRun ? "dry run" : run.trigger, formatUsd(run.costUsd), steps]);
    }
    lines.push("");
  }

  if (models) {
    lines.push("## Models per task", "");
    head(["Task", "Model", "Effort", "Set in"]);
    for (const [task, choice] of Object.entries(models)) row([task, choice.model, choice.effort, choice.source]);
    lines.push("");
  }
  return lines.join("\n");
}

const round = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000;

import { type CostsView, type RunCostView, type StepCostView } from "@realentity/storm-shared";
import { describe, expect, it } from "vitest";
import { byPipeline, costReport, filterRuns, formatTokens, totals } from "./costs";

const step = (stepKey: string, costUsd: number, more: Partial<StepCostView> = {}): StepCostView => ({
  stepKey,
  itemIndex: null,
  type: "llm.classify",
  models: ["claude-haiku-5-5"],
  calls: 1,
  inputTokens: 2000,
  outputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd,
  ...more,
});

const run = (runId: string, pipeline: string, steps: StepCostView[], dryRun = false): RunCostView => ({
  runId,
  pipelineId: `p-${pipeline}`,
  pipelineName: pipeline,
  version: 1,
  trigger: dryRun ? "dry-run" : "schedule",
  dryRun,
  status: "DONE",
  startedAt: "2026-11-01T08:00:00.000Z",
  costUsd: Math.round(steps.reduce((sum, s) => sum + s.costUsd, 0) * 1_000_000) / 1_000_000,
  steps,
});

const RUNS = [
  run("1", "Triage", [step("classify", 0.001), step("draft", 0.02, { type: "email.draftReply", models: ["claude-sonnet-5-5"], outputTokens: 600 })]),
  run("2", "Triage", [step("classify", 0.001)]),
  run("3", "Triage", [], true),
  run("4", "Prices", [step("read", 0.002, { itemIndex: 0 }), step("read", 0.002, { itemIndex: 1, calls: 2 })]),
];

describe("costs", () => {
  it("filters by pipeline and dry runs; totals count runs without LLM calls too", () => {
    expect(filterRuns(RUNS, { pipelineId: null, dryRuns: false }).map((r) => r.runId)).toEqual(["1", "2", "4"]);
    expect(filterRuns(RUNS, { pipelineId: "p-Prices", dryRuns: true }).map((r) => r.runId)).toEqual(["4"]);
    expect(totals(RUNS)).toEqual({ runs: 4, dryRuns: 1, paidRuns: 3, calls: 6, costUsd: 0.026, perRunUsd: 0.0065 });
  });

  it("per pipeline, the most expensive first; a step's forEach items add up, its share of the pipeline", () => {
    const [triage, prices] = byPipeline(RUNS);
    expect(triage).toMatchObject({ pipelineName: "Triage", runs: 3, dryRuns: 1, paidRuns: 2, costUsd: 0.022, maxRunUsd: 0.021, calls: 3 });
    expect(triage?.steps.map((s) => [s.stepKey, s.runs, s.calls, s.costUsd, Math.round(s.share * 100)])).toEqual([
      ["draft", 1, 1, 0.02, 91],
      ["classify", 2, 2, 0.002, 9],
    ]);
    expect(prices?.steps).toEqual([expect.objectContaining({ stepKey: "read", runs: 1, calls: 3, inputTokens: 4000, costUsd: 0.004, share: 1 })]);
  });

  it("the report: totals, steps with tokens per call, the most expensive runs, the models", () => {
    const view: CostsView = { days: 30, since: "2026-10-03T00:00:00.000Z", limit: 2000, truncated: false, runs: RUNS };
    const report = costReport(view, RUNS, { pipelineId: null, dryRuns: true }, {
      "email.draftReply": { model: "claude-sonnet-5-5", effort: "medium", source: "default" },
    });
    expect(report).toContain("# Storm LLM costs: last 30 days (since 2026-10-03)");
    expect(report).toContain("Runs: 4 (1 dry, 3 called the LLM) · LLM calls: 6 · total $0.0260 · $0.0065 per run");
    expect(report).toContain("| Triage | 3 | $0.0220 | $0.0073 | $0.0210 | 3 |");
    expect(report).toContain("| draft | email.draftReply | claude-sonnet-5-5 | 0.3 | 2.0K | 600 | 0 | 0 | $0.0067 | 91% |");
    expect(report).toContain("read[1] $0.0020 (2.0K in / 100 out)");
    expect(report).toContain("| email.draftReply | claude-sonnet-5-5 | medium | default |");
  });

  it("tokens", () => {
    expect(formatTokens(850.4)).toBe("850");
    expect(formatTokens(1234)).toBe("1.2K");
    expect(formatTokens(45_600)).toBe("46K");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });
});

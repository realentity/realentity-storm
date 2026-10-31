import { z } from "zod";
import { LIMIT, type TargetKind } from "./pipeline";

// #region Proposals

/**
 * Approve a proposal, optionally with an edited payload. For gate.act, the payload must still be valid input of the
 * step it approves; for gate.review, `{ items }` (a selection can only drop items). New targets outside the static
 * lists that an edit introduces must be listed in `approveNewTargets`.
 */
export const ApproveProposalSchema = z
  .object({
    payload: z.record(z.string(), z.unknown()).optional(),
    approveNewTargets: z.array(z.string().trim().toLowerCase().min(1).max(320)).max(20).default([]),
  })
  .strict();
export type ApproveProposalRequest = z.infer<typeof ApproveProposalSchema>;

export const RejectProposalSchema = z.object({ reason: z.string().trim().max(2000).optional() }).strict();
export type RejectProposalRequest = z.infer<typeof RejectProposalSchema>;

export const PROPOSAL_STATUSES = [
  "PREVIEW",
  "PENDING_REVIEW",
  "APPROVED",
  "EXECUTING",
  "WAITING_FOR_USER",
  "DONE",
  "FAILED",
  "REJECTED",
  "EXPIRED",
] as const;
export type ProposalStatusName = (typeof PROPOSAL_STATUSES)[number];

export interface TargetView {
  field: string;
  kind: TargetKind;
  value: string;
  basis: "static" | "provenance" | "approved" | null;
  isNew: boolean;
}

export interface ProposalView {
  proposalId: string;
  runId: string;
  pipelineId: string;
  pipelineName: string;
  /** act: approve the exact payload of a side effect. review: pick which items continue. */
  kind: "act" | "review";
  /** The step to act (act) or the review step (review). */
  stepKey: string;
  itemIndex: number | null;
  status: ProposalStatusName;
  target: string;
  targets: TargetView[];
  originalPayload: Record<string, unknown>;
  finalPayload: Record<string, unknown> | null;
  approvedNewTargets: string[];
  reasoning: string | null;
  dateCreated: string;
  decision: { kind: "APPROVED" | "EDITED" | "REJECTED"; reason: string | null; decidedAt: string } | null;
}

// #endregion

// #region Runs

export const StartRunSchema = z
  .object({
    /** Proposals are previews and side-effect steps are skipped (README §2.1). */
    dryRun: z.boolean().default(false),
  })
  .strict();
export type StartRunRequest = z.infer<typeof StartRunSchema>;

export const RUN_STATUSES = ["QUEUED", "RUNNING", "WAITING_FOR_USER", "DONE", "FAILED", "ABORTED"] as const;
export type RunStatusName = (typeof RUN_STATUSES)[number];

export type StepStatusName = "PENDING" | "RUNNING" | "WAITING" | "DONE" | "FAILED" | "SKIPPED";

/** History filters (query string). `target` matches a proposal's target (a domain or recipient), case-insensitive. */
export const RunFilterSchema = z
  .object({
    pipelineId: z.uuid().optional(),
    version: z.coerce.number().int().positive().optional(),
    status: z.enum(RUN_STATUSES).optional(),
    /** Started on or after this day (UTC). */
    from: z.iso.date().optional(),
    /** Started on or before this day (UTC). */
    to: z.iso.date().optional(),
    target: z.string().trim().min(1).max(320).optional(),
    /** Paging: runs started before this time (the last row's startedAt). */
    before: z.iso.datetime().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict()
  .refine((filter) => filter.version === undefined || filter.pipelineId !== undefined, {
    path: ["version"],
    message: "needs pipelineId",
  });
export type RunFilter = z.infer<typeof RunFilterSchema>;

export interface RunSummaryView {
  runId: string;
  pipelineId: string;
  pipelineName: string;
  version: number;
  trigger: string;
  dryRun: boolean;
  status: RunStatusName;
  summary: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** Held back by a rate limit until then. */
  resumeAt: string | null;
}

export interface RunStepView {
  stepId: string;
  stepKey: string;
  itemIndex: number | null;
  type: string;
  status: StepStatusName;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** LLM calls of this step, retries included. */
  llmUsage: StepUsageView | null;
}

export interface StepUsageView {
  models: string[];
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface RunDetailView extends RunSummaryView {
  /** LLM cost of the whole run. */
  costUsd: number;
  steps: RunStepView[];
  proposals: ProposalView[];
}

// #endregion

// #region Controls

export const KillSwitchSchema = z.object({ engaged: z.boolean() }).strict();
export type KillSwitchRequest = z.infer<typeof KillSwitchSchema>;

export interface KillSwitchView {
  engaged: boolean;
  engagedAt: string | null;
  /** Engaging: queued and waiting runs it stopped (running ones stop at their next step). */
  stoppedRuns?: number;
}

/** Steps that call the LLM, the nightly reflection and the builder chat; each can have its own model (README §5). */
export const LLM_TASKS = [
  "email.classify",
  "email.draftReply",
  "llm.classify",
  "llm.score",
  "llm.generate",
  "llm.summarize",
  "reflection",
  "builder",
] as const;
export type LlmTask = (typeof LLM_TASKS)[number];

/** Models that can be chosen in Settings (each has a price in @ai-me/llm). */
export const CLAUDE_MODELS = [
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-1",
] as const;

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortName = (typeof EFFORTS)[number];

const ModelChoiceSchema = z.object({ model: z.enum(CLAUDE_MODELS), effort: z.enum(EFFORTS) }).strict();

export const SettingsSchema = z
  .object({
    /** Task → model and effort; null: back to the default (LLM_MODEL_* or built in). */
    models: z.partialRecord(z.enum(LLM_TASKS), ModelChoiceSchema.nullable()).optional(),
    /** Step type → "N/day" | "N/hour": caps across all pipelines. */
    rateLimits: z.record(z.string(), z.string().regex(LIMIT, '"N/day" or "N/hour"')).optional(),
    /** null: back to LLM_MONTHLY_BUDGET_USD. */
    monthlyBudgetUsd: z.number().positive().max(100_000).nullable().optional(),
  })
  .strict();
export type SettingsRequest = z.infer<typeof SettingsSchema>;

export interface ModelChoiceView {
  model: string;
  effort: EffortName;
  /** settings: chosen here; env: LLM_MODEL_CLASSIFY / _WRITING / _REFLECTION / _BUILDER; default: built in. */
  source: "settings" | "env" | "default";
}

export interface SettingsView {
  models: Record<LlmTask, ModelChoiceView>;
  rateLimits: Record<string, string>;
  /** The budget in effect: the setting, else LLM_MONTHLY_BUDGET_USD, else none. */
  monthlyBudgetUsd: number | null;
  budgetSource: "settings" | "env" | null;
}

// #endregion

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
  /** That step's type (e.g. "browser.fillAndSubmit"): the inbox shows forms field by field. */
  stepType: string | null;
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
  /** LLM cost of the run so far (M17-T3). */
  costUsd: number;
}

/** Whether a failed run can go on from its failed steps (M17-T1), and why not. */
export interface RetryView {
  possible: boolean;
  reason: string | null;
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
  /** Uses the headed browser: it can be watched in the live view. */
  headed: boolean;
  steps: RunStepView[];
  proposals: ProposalView[];
  /** The live browser waiting for me now, if it is. */
  takeover: TakeoverView | null;
  artifacts: ArtifactView[];
  /** {{trigger}}: the event or webhook call that started it; in a dry run, an example of one. Null: none. */
  triggerData: unknown;
  /** A question the run waits for me to answer (M15-T3). */
  question: QuestionView | null;
  /** A failed run: whether Retry can go on from the failed steps. Null for other runs. */
  retry: RetryView | null;
}

export interface QuestionView {
  questionId: string;
  question: string;
  /** Choices: the answer is one of them. */
  options: string[];
  site: string | null;
  stepKey: string;
  status: "OPEN" | "ANSWERED" | "EXPIRED";
  answer: string | null;
  dateCreated: string;
}

export const AnswerQuestionSchema = z.object({ answer: z.string().trim().min(1).max(2000) }).strict();
export type AnswerQuestionRequest = z.infer<typeof AnswerQuestionSchema>;

/** Something about me only I can say (M15): a form's question and my answer. */
export interface FactView {
  factId: string;
  question: string;
  answer: string;
  source: "FORM" | "ASKED" | "ME";
  site: string | null;
  uses: number;
  lastUsedAt: string | null;
  dateCreated: string;
  dateUpdated: string;
}

/** One fact per question: "Salary expectation *:" and "salary expectation" are the same question. */
export function factKey(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export const FactSchema = z.object({ question: z.string().trim().min(1).max(300), answer: z.string().trim().min(1).max(2000) }).strict();
export type FactRequest = z.infer<typeof FactSchema>;

export const TAKEOVER_STATUSES = ["OPEN", "TAKEN_OVER", "CONTINUED", "ABORTED", "EXPIRED"] as const;
export type TakeoverStatusName = (typeof TAKEOVER_STATUSES)[number];

export interface TakeoverView {
  takeoverId: string;
  /** OPEN: the worker needs me; TAKEN_OVER: I took over. Both wait for Continue or Abort. */
  status: TakeoverStatusName;
  reason: string;
  stepKey: string | null;
  itemIndex: number | null;
  url: string | null;
  /** "google": it waits for Google Calendar to be reconnected, and continues once it is. */
  waitsFor: string | null;
  requestedAt: string;
  /** When the run gives up waiting. */
  expiresAt: string;
}

export interface ArtifactView {
  artifactId: string;
  kind: string;
  stepKey: string | null;
  itemIndex: number | null;
  mime: string | null;
  size: number | null;
  dateCreated: string;
}

/**
 * The live view of a run (README §6): where noVNC connects and with which password. The view-only password until I
 * take over (x11vnc ignores input on it); the full one while the run waits for me.
 */
export interface LiveView {
  /** VNC passwords are configured (VNC_PASSWORD, VNC_VIEW_PASSWORD). */
  available: boolean;
  /** The run is using the headed browser right now. */
  active: boolean;
  /** WebSocket path on this origin (behind the session check). */
  path: string;
  password: string | null;
  control: boolean;
  /**
   * What the display shows now. Most browser steps work in a hidden (headless) browser, and a headed step's window
   * closes when it ends: then the screen is an empty desktop, so the live view says so and shows the latest screenshot.
   */
  window: LiveWindow;
}

export interface LiveWindow {
  /** A browser window is on the display: a step that draws there is running, or the run waits for me in it. */
  open: boolean;
  /** The step running now, if any. */
  step: { stepKey: string; type: string } | null;
  /** The run's latest screenshot (the hidden browser's too). */
  screenshotId: string | null;
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

/** Steps that call the LLM, the nightly reflection, the builder chat and teach mode; each can have its own model (README §5). */
export const LLM_TASKS = [
  "email.classify",
  "email.draftReply",
  "llm.classify",
  "llm.score",
  "llm.generate",
  "llm.summarize",
  "llm.extract",
  "application.outcome",
  "reflection",
  "builder",
  "browser.teach",
  "shop.product",
  "browser.mapForm",
  "browser.agent",
  "browser.agent.escalation",
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
    /** Facts for application forms (browser.mapForm); "" clears it. */
    profile: z.string().max(10_000).optional(),
    /** Approve and Reject on the AI ME bot's messages (M12-T4). */
    telegramApprovals: z.boolean().optional(),
    /** The weekly review on Telegram, Sunday evening (M19-T4). */
    weeklyReview: z.boolean().optional(),
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
  /** Facts for application forms (browser.mapForm). */
  profile: string;
  telegramApprovals: boolean;
  weeklyReview: boolean;
}

/** Where the LLM money goes (M19-T3): this month against the budget, and the last 30 days by step type and model. */
export interface SpendingView {
  monthSpentUsd: number;
  monthlyBudgetUsd: number | null;
  /** The start of the 30 days. */
  since: string;
  totalUsd: number;
  /** The most expensive first. `source`: a step type, "reflection" (nightly) or "builder" (the pipeline chat). */
  rows: { source: string; model: string; calls: number; costUsd: number }[];
}

/** Google Calendar (M14-T1): as last seen when the calendar was used; nothing checks it in the background. */
export interface GoogleStatusView {
  /** GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set. */
  configured: boolean;
  /** The sign-in return address to register on the Google client. */
  redirectUri: string;
  connected: boolean;
  email: string | null;
  status: "CONNECTED" | "NEEDS_RECONNECT" | null;
  lastWorkedAt: string | null;
  brokenAt: string | null;
  brokenReason: string | null;
}

/** A pipeline to start later (flow.later, M14-T3). */
export interface ScheduledStartView {
  scheduledStartId: string;
  pipelineId: string;
  pipeline: string;
  key: string | null;
  fireAt: string;
  status: "PENDING" | "STARTED" | "CANCELLED" | "SKIPPED";
  reason: string | null;
  data: unknown;
  scheduledByRunId: string | null;
  runId: string | null;
}

// #endregion

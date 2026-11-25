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

/**
 * M53: a batch decided at once: proposals of one gate step of one run (a forEach's items), each approved as it was
 * proposed (unedited: open one to edit it) or rejected. All or none: one already decided refuses the whole batch.
 */
export const DecideBatchSchema = z
  .object({
    approve: z.array(z.uuid()).max(500).default([]),
    reject: z.array(z.uuid()).max(500).default([]),
    /** New targets approved for every proposal approved here. */
    approveNewTargets: z.array(z.string().trim().toLowerCase().min(1).max(320)).max(20).default([]),
    reason: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((b) => b.approve.length + b.reject.length > 0, "nothing to decide")
  .refine((b) => !b.approve.some((id) => b.reject.includes(id)), "a proposal is either approved or rejected");
export type DecideBatchRequest = z.infer<typeof DecideBatchSchema>;

/** M54: what an auto-approved proposal's decision says (its reason), in the history; reflection leaves it out. */
export const AUTO_APPROVED = "Approved by starting the run (auto-approve)";

export interface BatchDecisionView {
  approved: number;
  rejected: number;
}

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
  /**
   * An email's sender: the email account it goes out from, as the worker picks it (the one the payload's `account`
   * names, by id or slot, else the default). null for any other step, or when there is no such account.
   */
  from: { emailAccountId: string; address: string; label: string | null } | null;
  approvedNewTargets: string[];
  reasoning: string | null;
  dateCreated: string;
  decision: { kind: "APPROVED" | "EDITED" | "REJECTED"; reason: string | null; decidedAt: string } | null;
}

// #endregion

// #region Runs

export const StartRunSchema = z
  .object({
    /** Proposals are previews and side-effect steps are skipped (docs/design.md §2.1). */
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
    /** Only runs where something failed: failed ones, and done ones with failed items (onError: continue). */
    failures: z.stringbool().optional(),
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

/** The menu's count of new failures: real runs that ended with something failed after this time. */
export const FailureCountQuerySchema = z.object({ since: z.iso.datetime() }).strict();
export type FailureCountQuery = z.infer<typeof FailureCountQuerySchema>;

export interface FailureCountView {
  count: number;
}

/** A pipeline's latest real run (dry runs aside), for the Pipelines list. */
export interface LastRunView {
  runId: string;
  status: RunStatusName;
  /** A done run's items that failed and didn't stop it. */
  failedItems: number;
  startedAt: string;
}

export interface RunSummaryView {
  runId: string;
  pipelineId: string;
  pipelineName: string;
  version: number;
  trigger: string;
  dryRun: boolean;
  status: RunStatusName;
  /** M54-T5: a done run's items that failed and didn't stop it (onError: continue): it is done with failures. */
  failedItems: number;
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
  /** Prompt tokens read from the cache (a tenth of the input price, or less) and written to it (1.25×). */
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/** Costs (M28): every run of the last `days`, with its LLM steps, to see where the money goes and copy it out. */
export const CostsQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }).strict();
export type CostsQuery = z.infer<typeof CostsQuerySchema>;

export interface CostsView {
  days: number;
  since: string;
  /** Only the newest this many runs are listed; `truncated` says there were more. */
  limit: number;
  truncated: boolean;
  runs: RunCostView[];
}

export interface RunCostView {
  runId: string;
  pipelineId: string;
  pipelineName: string;
  version: number;
  trigger: string;
  dryRun: boolean;
  status: RunStatusName;
  startedAt: string;
  costUsd: number;
  /** The steps that called the LLM, in the order they started. */
  steps: StepCostView[];
}

export interface StepCostView extends StepUsageView {
  stepKey: string;
  itemIndex: number | null;
  type: string;
}

export interface RunDetailView extends RunSummaryView {
  /** LLM cost of the whole run. */
  costUsd: number;
  /** Uses the headed browser: it can be watched in the live view. */
  headed: boolean;
  steps: RunStepView[];
  proposals: ProposalView[];
  /** The live browser waiting for the user now, if it is. */
  takeover: TakeoverView | null;
  artifacts: ArtifactView[];
  /** {{trigger}}: the event or webhook call that started it; in a dry run, an example of one. Null: none. */
  triggerData: unknown;
  /** M37-T3: a dry run tried up to this step; null: the whole pipeline. */
  stopAfter: string | null;
  /** A question the run waits for the user to answer (M15-T3). */
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

/** Something about the user only they can say (M15): a form's question and their answer. */
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
  /** OPEN: the worker needs the user; TAKEN_OVER: the user took over. Both wait for Continue or Abort. */
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
 * The live view of a run (docs/design.md §6): where noVNC connects and with which password. The view-only password until
 * the user takes over (x11vnc ignores input on it); the full one while the run waits for the user.
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
  /** A browser window is on the display: a step that draws there is running, or the run waits for the user in it. */
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

/** Steps that call the LLM, the nightly reflection, the builder chat and teach mode; each can have its own model (docs/design.md §5). */
export const LLM_TASKS = [
  "email.classify",
  "email.draftReply",
  "email.draftFollowUp",
  "bill.read",
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

/** Models that can be chosen in Settings (each has a price in @realentity/storm-llm). */
export const CLAUDE_MODELS = [
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-fable-5-1",
] as const;

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** A builder chat stops answering once its calls used this many tokens (Settings → AI can change it, M62). */
export const BUILDER_CHAT_MAX_TOKENS = 2_000_000;
export type EffortName = (typeof EFFORTS)[number];

/** M62: a model on a model server of Settings → AI: `openai:<integrationId>:<its name there>`. */
export const OPENAI_MODEL = /^openai:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\S{1,200}$/i;

/** A Claude model, or a model on one of the model servers. */
const ModelId = z.union([z.enum(CLAUDE_MODELS), z.string().regex(OPENAI_MODEL, "a Claude model or a model on one of your model servers")]);

const ModelChoiceSchema = z.object({ model: ModelId, effort: z.enum(EFFORTS) }).strict();

/** "https://hooks.example.com/hooks/" → "https://hooks.example.com/hooks" (a loop: no backtracking regex). */
function withoutTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end--;
  return url.slice(0, end);
}

export const SettingsSchema = z
  .object({
    /** Task → model and effort; null: back to the default model. */
    models: z.partialRecord(z.enum(LLM_TASKS), ModelChoiceSchema.nullable()).optional(),
    /** Step type → "N/day" | "N/hour": caps across all pipelines. */
    rateLimits: z.record(z.string(), z.string().regex(LIMIT, '"N/day" or "N/hour"')).optional(),
    /** null: no limit. */
    monthlyBudgetUsd: z.number().positive().max(100_000).nullable().optional(),
    /** Facts for application forms (browser.mapForm); "" clears it. */
    profile: z.string().max(10_000).optional(),
    /** Approve and Reject on the Storm bot's messages (M12-T4). */
    telegramApprovals: z.boolean().optional(),
    /** The weekly review on Telegram, Sunday evening (M19-T4). */
    weeklyReview: z.boolean().optional(),
    /** The morning brief on Telegram (M25). */
    morningBrief: z.boolean().optional(),
    /** M62: the model of every task without its own choice; null: each task group's built-in default. */
    defaultModel: ModelId.nullable().optional(),
    /** M62: embeddings from a model server and its model (OpenAI's text-embedding-3-large, bge-m3 on Ollama); null: off. */
    embeddings: z.object({ integrationId: z.uuid(), model: z.string().min(1).max(200) }).strict().nullable().optional(),
    /** M62: a builder chat stops at this many tokens; null: 2,000,000. */
    builderChatMaxTokens: z.number().int().min(10_000).max(100_000_000).nullable().optional(),
    /** M63: the public address of the webhooks (https), e.g. https://hooks.example.com/hooks; null: only their paths. */
    hooksPublicUrl: z
      .url({ protocol: /^https$/ })
      .max(500)
      .transform(withoutTrailingSlashes)
      .nullable()
      .optional(),
    /** M63, Settings → Runs & browser; null: the default (RUN_LIMIT_DEFAULTS). Run files kept this many days, 0: always. */
    artifactsRetentionDays: z.number().int().min(0).max(3650).nullable().optional(),
    /** A run waiting for you in the live view gives up after this many minutes. */
    takeoverTimeoutMinutes: z.number().int().min(1).max(120).nullable().optional(),
    /** Downloads and uploads larger than this many MB are refused. */
    downloadMaxMb: z.number().int().min(1).max(500).nullable().optional(),
  })
  .strict();
export type SettingsRequest = z.infer<typeof SettingsSchema>;

export interface ModelChoiceView {
  model: string;
  effort: EffortName;
  /** settings: chosen here for the task; default: the default model (M62); built-in: the task group's own. */
  source: "settings" | "default" | "built-in";
  /** The model chosen for this task while its server is off or gone (M62): used again once it is back. */
  waiting?: string;
}

export interface SettingsView {
  models: Record<LlmTask, ModelChoiceView>;
  /** M62: the model of every task without its own choice; null: the task groups' built-in defaults. */
  defaultModel: string | null;
  /**
   * M62: what can be chosen, by server: Claude's models while Claude is set up and on, each model server's (as
   * `openai:<integrationId>:<name>`) while it is on. `error`: a server that didn't list them.
   */
  servers: { integrationId: string; kind: "CLAUDE" | "OPENAI_COMPATIBLE"; name: string; enabled: boolean; models: { id: string; name: string }[]; error: string | null }[];
  /** M62: the embeddings' server and model; null: off. */
  embeddings: { integrationId: string; model: string } | null;
  /** M62: a builder chat stops at this many tokens. */
  builderChatMaxTokens: number;
  rateLimits: Record<string, string>;
  /** The monthly LLM budget; null: no limit. */
  monthlyBudgetUsd: number | null;
  /** Facts for application forms (browser.mapForm). */
  profile: string;
  telegramApprovals: boolean;
  weeklyReview: boolean;
  morningBrief: boolean;
  /** M63: the webhooks' public address; null: not set. */
  hooksPublicUrl: string | null;
  /** M63: the run limits in effect (the default while none is set). */
  artifactsRetentionDays: number;
  takeoverTimeoutMinutes: number;
  downloadMaxMb: number;
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
/** M50-T8: one of the user's Google accounts, as Settings shows it. */
export interface GoogleAccountView {
  googleAccountId: string;
  email: string;
  status: "CONNECTED" | "NEEDS_RECONNECT";
  isDefault: boolean;
  /** What the user allowed at the sign-in: the calendar, Drive (read-only). */
  calendar: boolean;
  drive: boolean;
  lastWorkedAt: string | null;
  brokenAt: string | null;
  brokenReason: string | null;
  /** The pipelines and Apps whose google slot is filled with it. */
  usedBy: { owner: "pipeline" | "app"; id: string; name: string; slot: string }[];
}

export interface GoogleStatusView {
  /** Google's OAuth client is set up (Settings → Google, M63). */
  configured: boolean;
  /** The sign-in return address to register on the Google client. */
  redirectUri: string;
  /** M50-T8: the user's Google accounts, the default first. */
  accounts: GoogleAccountView[];
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

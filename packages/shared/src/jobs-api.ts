import { z } from "zod";

// #region Jobs

export const JOB_STATUSES = ["NEW", "SHORTLISTED", "SKIPPED", "APPLIED"] as const;
export type JobStatusName = (typeof JOB_STATUSES)[number];

/** The Jobs page's filters (query string): status, a minimum score, words in the title or company. */
export const JobFilterSchema = z
  .object({
    status: z.enum(JOB_STATUSES).optional(),
    minScore: z.coerce.number().int().min(0).max(100).optional(),
    q: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  })
  .strict();
export type JobFilter = z.infer<typeof JobFilterSchema>;

export const UpdateJobSchema = z.object({ status: z.enum(JOB_STATUSES) }).strict();
export type UpdateJobRequest = z.infer<typeof UpdateJobSchema>;

export interface JobPostingView {
  jobPostingId: string;
  url: string;
  title: string;
  company: string | null;
  location: string | null;
  /** The recipe it came from ("dev.bg/search"). */
  source: string;
  score: number | null;
  scoreReason: string | null;
  status: JobStatusName;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Prepared by browser.mapForm, submitted by browser.fillAndSubmit (M10-T5). */
  application: ApplicationView | null;
}

export const APPLICATION_STATUSES = ["PREPARED", "SUBMITTED", "RESPONDED", "REJECTED", "INTERVIEW"] as const;
export type ApplicationStatusName = (typeof APPLICATION_STATUSES)[number];

export interface ApplicationView {
  applicationId: string;
  status: ApplicationStatusName;
  submittedAt: string | null;
  /** When the employer answered, invited me, turned me down (M16): kept when the status moves on. */
  respondedAt: string | null;
  interviewAt: string | null;
  rejectedAt: string | null;
  notes: string | null;
  /** The run that prepared or submitted it. */
  runId: string | null;
}

/** The order outcomes happen in (M16): an email moves an application forward only; by hand, anywhere. */
const OUTCOME_ORDER: Record<ApplicationStatusName, number> = { PREPARED: 0, SUBMITTED: 1, RESPONDED: 2, INTERVIEW: 3, REJECTED: 4 };

export function movesForward(from: ApplicationStatusName, to: ApplicationStatusName): boolean {
  return OUTCOME_ORDER[to] > OUTCOME_ORDER[from];
}

/** The outcome date a status sets (the first time only): RESPONDED → respondedAt, and so on. */
export const OUTCOME_DATE = { RESPONDED: "respondedAt", INTERVIEW: "interviewAt", REJECTED: "rejectedAt" } as const;

/** An application's outcome set by hand on the Jobs page (M16-T3). */
export const UpdateApplicationSchema = z
  .object({ status: z.enum(["SUBMITTED", "RESPONDED", "INTERVIEW", "REJECTED"]), note: z.string().trim().max(500).optional() })
  .strict();
export type UpdateApplicationRequest = z.infer<typeof UpdateApplicationSchema>;

/** One row of the job-search funnel (M16-T1): a source, a score band, or all of them. */
export interface FunnelRow {
  key: string;
  found: number;
  shortlisted: number;
  applied: number;
  replied: number;
  interview: number;
  rejected: number;
  /** Applied, no answer yet. */
  waiting: number;
}

/** The job-search dashboard (M16-T1): postings found in the window and what came of them. */
export interface InsightView {
  days: number;
  from: string;
  totals: FunnelRow;
  bySource: FunnelRow[];
  /** The calibration view: does a higher score get more replies and interviews? Bands 80+, 60-79, 40-59, 0-39, unscored. */
  byScore: FunnelRow[];
  /** Applications answered: the median days from applying to the first answer; null without any. */
  medianDaysToAnswer: number | null;
}

// #endregion

// #region Documents

/** A document name: lowercase letters, digits, ".", "_" and "-", e.g. "cv-main". */
export const DOCUMENT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface DocumentView {
  documentId: string;
  name: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  dateCreated: string;
}

// #endregion

// #region Recipes

export interface RecipeSummaryView {
  name: string;
  site: string;
  /** The latest version: the one runs use. */
  version: number;
  lastVerifiedAt: string | null;
  /** M18-T2: when it last found items; `quiet`: nothing found for a week (told on Telegram). */
  lastItemsAt: string | null;
  quiet: boolean;
  brokenAt: string | null;
  brokenReason: string | null;
  /** M11-T3: the agent found a fix for the broken version, waiting for me on the Recipes page. */
  proposedAt: string | null;
  dateCreated: string;
}

export interface RecipeVersionView {
  version: number;
  /** The recipe itself (@realentity/storm-steps RecipeSchema). */
  recipe: unknown;
  lastVerifiedAt: string | null;
  lastItemsAt: string | null;
  quiet: boolean;
  brokenAt: string | null;
  brokenReason: string | null;
  /** The teach-mode run that made it; null: imported. */
  taughtInRunId: string | null;
  /** M11-T3: a fix browser.extract's fallback found when this version broke (a recipe, like `recipe`), or null. */
  proposed: unknown;
  proposedAt: string | null;
  proposedInRunId: string | null;
  dateCreated: string;
}

export interface RecipeDetailView {
  name: string;
  site: string;
  /** Newest first. */
  versions: RecipeVersionView[];
}

/** A recipe as YAML or JSON, saved as the next version of `name` (checked like a taught one). */
export const ImportRecipeSchema = z.object({ name: z.string().trim().min(3).max(100), source: z.string().min(2).max(50_000) }).strict();
export type ImportRecipeRequest = z.infer<typeof ImportRecipeSchema>;

/** Teach mode (README §2.4): a run of the "Teach <name>" pipeline, in the live browser. */
export const TeachRecipeSchema = z
  .object({
    name: z.string().trim().min(3).max(100),
    url: z.url({ protocol: /^https?$/ }),
    /** Values in the list's address that become params, e.g. { category: "net" }. */
    params: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/), z.string().min(1).max(200)).default({}),
    fields: z
      .array(z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/))
      .min(1)
      .max(15)
      .optional(),
    hint: z.string().trim().max(1000).optional(),
  })
  .strict();
export type TeachRecipeRequest = z.infer<typeof TeachRecipeSchema>;

export interface TeachStartedView {
  runId: string;
  pipelineId: string;
}

// #endregion

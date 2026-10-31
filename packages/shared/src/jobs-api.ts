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
}

// #endregion

// #region Recipes

export interface RecipeSummaryView {
  name: string;
  site: string;
  /** The latest version: the one runs use. */
  version: number;
  lastVerifiedAt: string | null;
  brokenAt: string | null;
  brokenReason: string | null;
  dateCreated: string;
}

export interface RecipeVersionView {
  version: number;
  /** The recipe itself (@ai-me/steps RecipeSchema). */
  recipe: unknown;
  lastVerifiedAt: string | null;
  brokenAt: string | null;
  brokenReason: string | null;
  /** The teach-mode run that made it; null: imported. */
  taughtInRunId: string | null;
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

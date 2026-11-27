import { z } from "zod";

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
  /** M11-T3: the agent found a fix for the broken version, waiting for the user on the Recipes page. */
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

/** Teach mode (docs/design.md §2.4): a run of the "Teach <name>" pipeline, in the live browser. */
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

/**
 * Try a recipe: a dry run of the "Try <name>" pipeline, browser.extract with its latest version, which reads the list and
 * leaves the recipe as it is (not verified, not broken, nobody told).
 */
export const TryRecipeSchema = z
  .object({
    /** A value for each of the recipe's params (those with a default may be left out). */
    params: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/), z.string().trim().min(1).max(200)).default({}),
    maxItems: z.number().int().min(1).max(200).default(50),
  })
  .strict();
export type TryRecipeRequest = z.infer<typeof TryRecipeSchema>;

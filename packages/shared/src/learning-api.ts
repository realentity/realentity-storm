import { z } from "zod";
import { LLM_TASKS } from "./runs-api";

/** Step types a rule can be for (docs/design.md §8): the LLM steps. A rule without one applies to all of them. */
export const RULE_STEP_TYPES = LLM_TASKS.filter((task) => task !== "reflection" && task !== "builder" && task !== "browser.teach" && task !== "shop.product");
export type RuleStepType = (typeof RULE_STEP_TYPES)[number];

export const RULE_STATUSES = ["SUGGESTED", "ACTIVE", "DISABLED"] as const;
export type RuleStatusName = (typeof RULE_STATUSES)[number];

export const SUGGESTION_STATUSES = ["OPEN", "DONE", "DISMISSED"] as const;
export type SuggestionStatusName = (typeof SUGGESTION_STATUSES)[number];

const RuleText = z.string().trim().min(3).max(1000);
const RuleStepType = z.enum(RULE_STEP_TYPES as [RuleStepType, ...RuleStepType[]]).nullable();

/** A rule the user writes: active right away. */
export const CreateRuleSchema = z
  .object({
    text: RuleText,
    stepType: RuleStepType.default(null),
    pipelineId: z.uuid().nullable().default(null),
  })
  .strict();
export type CreateRuleRequest = z.infer<typeof CreateRuleSchema>;

/** Approve (ACTIVE), disable, re-enable or edit a rule; suggested ones only become active this way. */
export const UpdateRuleSchema = z
  .object({
    text: RuleText.optional(),
    stepType: RuleStepType.optional(),
    pipelineId: z.uuid().nullable().optional(),
    status: z.enum(RULE_STATUSES).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "nothing to change");
export type UpdateRuleRequest = z.infer<typeof UpdateRuleSchema>;

export const UpdateSuggestionSchema = z.object({ status: z.enum(SUGGESTION_STATUSES) }).strict();
export type UpdateSuggestionRequest = z.infer<typeof UpdateSuggestionSchema>;

export interface RuleView {
  ruleId: string;
  /** null: every LLM step. */
  stepType: string | null;
  /** null: every pipeline. */
  pipelineId: string | null;
  pipelineName: string | null;
  text: string;
  rationale: string | null;
  status: RuleStatusName;
  /** "manual", or the reflection that suggested it. */
  source: string | null;
  dateCreated: string;
  dateUpdated: string;
}

export interface PipelineSuggestionView {
  suggestionId: string;
  pipelineId: string;
  pipelineName: string;
  text: string;
  rationale: string | null;
  status: SuggestionStatusName;
  dateCreated: string;
}

export interface ReflectionView {
  reflectionId: string;
  status: "SUBMITTED" | "DONE" | "FAILED";
  since: string;
  until: string;
  decisions: number;
  costUsd: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** The Rules page: rules, pipeline suggestions, recent reflections and what the examples cover. */
export interface LearningView {
  rules: RuleView[];
  suggestions: PipelineSuggestionView[];
  reflections: ReflectionView[];
  /** Approved outputs kept as few-shot examples, per step type. */
  examples: { stepType: string; count: number }[];
  /** OPENAI_API_KEY is set: drafts retrieve similar examples. */
  embeddings: boolean;
}

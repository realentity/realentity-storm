import { z } from "zod";
import { type CompiledDefinition, type CompiledPolicy, type CompileResult } from "./pipeline";
import { type RunDetailView } from "./runs-api";

/** Pipeline source as authored: YAML (JSON is valid YAML). */
export const PipelineSourceSchema = z.object({ source: z.string().min(1).max(200_000) });
export type PipelineSourceRequest = z.infer<typeof PipelineSourceSchema>;

export const CompilePipelineSchema = PipelineSourceSchema.extend({
  /** When set, the response includes the diff against this pipeline's current version. */
  pipelineId: z.uuid().optional(),
});
export type CompilePipelineRequest = z.infer<typeof CompilePipelineSchema>;

/**
 * Dry run before saving (README §2.1): the source becomes the pipeline's draft (a new pipeline without one), and a
 * dry run of the draft starts. Saving the same source later turns the draft into the next version.
 */
export const DryRunPipelineSchema = CompilePipelineSchema;
export type DryRunPipelineRequest = CompilePipelineRequest;

export interface DryRunPipelineResponse {
  pipeline: PipelineDetailView;
  run: RunDetailView;
}

/** Enable (run on its schedule) and mark essential (keeps running when the LLM budget is spent). */
export const UpdatePipelineSchema = z
  .object({ enabled: z.boolean().optional(), essential: z.boolean().optional() })
  .strict()
  .refine((body) => body.enabled !== undefined || body.essential !== undefined, "nothing to update");
export type UpdatePipelineRequest = z.infer<typeof UpdatePipelineSchema>;

/** One change between two compiled versions (v3 → v4), computed in @ai-me/steps. */
export type DefinitionChange =
  | { kind: "pipeline"; field: "name" | "description" | "trigger"; before: unknown; after: unknown }
  | { kind: "limit"; stepType: string; before?: string; after?: string }
  | { kind: "policy"; list: "allowedDomains" | "allowedRecipients"; added: string[]; removed: string[] }
  | { kind: "step-added"; stepId: string; type: string; autoInserted: boolean }
  | { kind: "step-removed"; stepId: string; type: string; autoInserted: boolean }
  | { kind: "step-moved"; stepId: string; from: number; to: number }
  | { kind: "step-changed"; stepId: string; field: string; before: unknown; after: unknown };

export interface DefinitionDiff {
  changes: DefinitionChange[];
  /** One line per change, for PipelineVersion.changeSummary and the review screen. */
  summary: string;
}

export interface CompilePipelineResponse {
  result: CompileResult;
  diff?: DefinitionDiff;
}

/** A step type of the catalog, as the review screen describes it. */
export interface StepTypeView {
  type: string;
  description: string;
  sideEffect: boolean;
  headed: boolean;
}

export interface PipelineSummaryView {
  pipelineId: string;
  name: string;
  enabled: boolean;
  essential: boolean;
  /** null: never saved (only a draft so far). */
  currentVersion: number | null;
  hasDraft: boolean;
  dateCreated: string;
  dateUpdated: string;
}

export interface PipelineVersionSummaryView {
  pipelineVersionId: string;
  version: number;
  changeSummary: string | null;
  dateCreated: string;
}

export interface PipelineVersionView extends PipelineVersionSummaryView {
  definition: CompiledDefinition;
  policy: CompiledPolicy;
}

export interface PipelineDetailView extends PipelineSummaryView {
  current: PipelineVersionView | null;
  /** Not saved yet; it only gets dry runs. */
  draft: PipelineVersionView | null;
  /** Saved versions, newest first. */
  versions: PipelineVersionSummaryView[];
}

/** A pipeline's webhook (M12-T2). The secret is in the answer to creating or rotating it, and never again. */
export interface WebhookView {
  /** Where the VPS forwards it on the server: POST /hooks/<webhookId>. */
  path: string;
  /** The address to give the caller (HOOKS_PUBLIC_URL + /<webhookId>); null when HOOKS_PUBLIC_URL isn't set. */
  url: string | null;
  lastCalledAt: string | null;
  dateCreated: string;
  /** Only right after it was created or rotated. */
  secret?: string;
}

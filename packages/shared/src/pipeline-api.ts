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
export const DryRunPipelineSchema = CompilePipelineSchema.extend({
  /** M37-T3: try up to this step: the run stops after it. */
  stopAfter: z.string().min(1).max(64).optional(),
});
export type DryRunPipelineRequest = z.infer<typeof DryRunPipelineSchema>;

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

/** One change between two compiled versions (v3 → v4), computed in @realentity/storm-steps. */
export type DefinitionChange =
  | { kind: "pipeline"; field: "name" | "description" | "app" | "trigger" | "view"; before: unknown; after: unknown }
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

/** What a pipeline's LLM calls cost (M17-T3): its runs of the last `days`, and per month on its schedule. */
export interface PipelineCostView {
  days: number;
  runs: number;
  /** Of them, dry runs (they cost the same). */
  dryRuns: number;
  totalUsd: number;
  /** The average of its real runs; of its dry runs when it has no real ones yet. Null: no runs. */
  perRunUsd: number | null;
  /** How often its schedule fires in 30 days; null when it isn't scheduled. */
  runsPerMonth: number | null;
  /** perRunUsd × runsPerMonth: what enabling the schedule costs a month, as far as the past runs tell. */
  perMonthUsd: number | null;
}

export interface CompilePipelineResponse {
  result: CompileResult;
  diff?: DefinitionDiff;
  /** M39-T5: the draft renames the pipeline: what refers to it, which follows the new name. */
  renamed?: RenameView;
}

/** M39-T5: a rename, and what refers to what is renamed (by id, so it follows the new name): said before Save. */
export interface RenameView {
  from: string;
  to: string;
  /** "Morning digest (its trigger)", "a button of Bills". */
  followers: string[];
}

/** A JSON Schema (draft 2020-12) of a step's input or output, as `z.toJSONSchema` gives it. */
export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  additionalProperties?: JsonSchema | boolean;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  [key: string]: unknown;
}

/** A step type of the catalog, as the review screen and the step builder (M36) describe it. */
export interface StepTypeView {
  type: string;
  description: string;
  sideEffect: boolean;
  headed: boolean;
  /** M36: the part of its type before the dot (email, data, notify…), how the builder groups steps. */
  category: string;
  /** M36: its `with`, and what it gives its later steps, as JSON Schema. */
  input: JsonSchema;
  output: JsonSchema;
  /** Its output may hold an LLM's text: never a side effect's target. */
  llmOutput: boolean;
  /** Input fields that name an outside target (side effects), and of what kind. */
  targets: Record<string, string>;
  /** Input fields that may hold {{cred:name}}: all of them (true), these, or none. */
  credentials: boolean | string[];
  /** Output fields of an LLM step that come from the page, not the LLM (a form's address): they may be targets. */
  pageFields: string[];
  /** Inputs shown on its card though not required (http.fetch's url). */
  primary: string[];
  /** M40-T2: the App types it writes (or reads, a type of mine) by its contracts: bill.save writes Bill. */
  entities: { type: string; mine: boolean }[];
}

/** M36-T4: what {{trigger}} holds, by event, and for a webhook: for the step builder's data picker. */
export interface TriggerDataView {
  events: Record<string, JsonSchema>;
  webhook: JsonSchema;
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
  /** Its LLM cost: the last 30 days, per run, per month on its schedule (M17-T3). */
  cost: PipelineCostView;
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

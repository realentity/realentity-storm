import { z } from "zod";
import { type CompiledDefinition, type CompiledPolicy, type CompileResult } from "./pipeline";

/** Pipeline source as authored: YAML (JSON is valid YAML). */
export const PipelineSourceSchema = z.object({ source: z.string().min(1).max(200_000) });
export type PipelineSourceRequest = z.infer<typeof PipelineSourceSchema>;

export const CompilePipelineSchema = PipelineSourceSchema.extend({
  /** When set, the response includes the diff against this pipeline's current version. */
  pipelineId: z.uuid().optional(),
});
export type CompilePipelineRequest = z.infer<typeof CompilePipelineSchema>;

/** Enable (run on its schedule) and mark essential (keeps running when the LLM budget is spent). */
export const UpdatePipelineSchema = z
  .object({ enabled: z.boolean().optional(), essential: z.boolean().optional() })
  .strict()
  .refine((body) => body.enabled !== undefined || body.essential !== undefined, "nothing to update");
export type UpdatePipelineRequest = z.infer<typeof UpdatePipelineSchema>;

export interface DefinitionChangeView {
  kind: string;
  [key: string]: unknown;
}

export interface CompilePipelineResponse {
  result: CompileResult;
  diff?: { changes: DefinitionChangeView[]; summary: string };
}

export interface PipelineSummaryView {
  pipelineId: string;
  name: string;
  enabled: boolean;
  essential: boolean;
  currentVersion: number | null;
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
  versions: PipelineVersionSummaryView[];
}

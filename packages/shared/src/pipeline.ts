import { z } from "zod";
import { HOST_PATTERN } from "./credentials";

/**
 * Pipeline definition (README §2.2): what a pipeline is authored as (YAML or JSON) before compilation.
 * This schema checks structure only. Step inputs (`with`) are checked by the compiler in @ai-me/steps against the
 * step catalog, because they may contain {{references}} to earlier steps.
 */

/** Step ids are used in references ({{search.items}}), so no dots; `item` and `cred` are reserved. */
export const STEP_ID = /^[a-z][a-zA-Z0-9_]{0,39}$/;
export const RESERVED_STEP_IDS = ["item", "cred"] as const;

/** A reference: {{step.field.sub}}, {{item.field}} (inside forEach) or {{cred:name}} (credential, resolved by the worker). */
export const REFERENCE = /\{\{\s*([^{}]+?)\s*\}\}/g;
/** A value that is exactly one reference, so it passes the referenced value as it is (not as text). */
export const WHOLE_REFERENCE = /^\{\{\s*([^{}]+?)\s*\}\}$/;

/** Five-field cron: minute hour day-of-month month day-of-week. */
const CRON = /^(\S+\s+){4}\S+$/;

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const TriggerSchema = z.union([
  z.literal("manual"),
  z.object({
    schedule: z.string().trim().regex(CRON, 'a five-field cron expression, e.g. "0 8 * * 1-5"'),
    tz: z.string().default("Europe/Sofia").refine(isTimeZone, "an IANA time zone, e.g. Europe/Sofia"),
  }),
]);
export type Trigger = z.infer<typeof TriggerSchema>;

export const PipelineStepSchema = z
  .object({
    id: z
      .string()
      .regex(STEP_ID, "letters, digits and _, starting with a lowercase letter (max 40)")
      .refine((id) => !(RESERVED_STEP_IDS as readonly string[]).includes(id), "is reserved"),
    type: z.string().regex(/^[a-z]+\.[a-zA-Z]+$/, "a step type from the catalog, e.g. llm.score"),
    forEach: z.string().regex(WHOLE_REFERENCE, 'a single reference to a list, e.g. "{{search.items}}"').optional(),
    with: z.record(z.string(), z.unknown()).default({}),
    retries: z.number().int().min(0).max(5).optional(),
  })
  .strict();
export type PipelineStep = z.infer<typeof PipelineStepSchema>;

/** "10/day" or "3/hour": at most N executions of a step type per window. */
export const LIMIT = /^(\d{1,5})\/(hour|day)$/;

export const PipelinePolicySchema = z
  .object({
    allowedDomains: z.array(z.string().trim().toLowerCase().regex(HOST_PATTERN, "an exact host or *.host")).default([]),
    allowedRecipients: z.array(z.email().toLowerCase()).default([]),
  })
  .strict();
export type PipelinePolicy = z.infer<typeof PipelinePolicySchema>;

export const PipelineDefinitionSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(2000).optional(),
    trigger: TriggerSchema.default("manual"),
    steps: z.array(PipelineStepSchema).min(1).max(50),
    limits: z.record(z.string(), z.string().regex(LIMIT, '"N/day" or "N/hour"')).default({}),
    policy: PipelinePolicySchema.default({ allowedDomains: [], allowedRecipients: [] }),
  })
  .strict();
export type PipelineDefinition = z.infer<typeof PipelineDefinitionSchema>;

/** A step after compilation: defaults applied, and marked when the compiler inserted it (gates). */
export interface CompiledStep extends PipelineStep {
  autoInserted?: boolean;
}

export interface CompiledDefinition extends Omit<PipelineDefinition, "steps"> {
  steps: CompiledStep[];
}

/** What side-effect steps may target, enforced at run time (README §2.2 "Policy"). */
export interface CompiledPolicy {
  /** Static allowlists: the definition's policy plus literal targets found in steps. */
  allowedDomains: string[];
  allowedRecipients: string[];
  /** Targets that must come from an earlier step's actual output, never from LLM text. */
  provenance: ProvenanceRule[];
}

export type TargetKind = "domain" | "recipient";

export interface ProvenanceRule {
  stepId: string;
  field: string;
  kind: TargetKind;
  /** The reference path the value must come from, e.g. "fetch.from" or "item.applyUrl". */
  source: string;
}

export interface CompileIssue {
  /** Where in the definition, e.g. "steps[2].with.items". */
  path: string;
  message: string;
}

export type CompileResult =
  { ok: true; definition: CompiledDefinition; policy: CompiledPolicy; warnings: CompileIssue[] } | { ok: false; errors: CompileIssue[] };

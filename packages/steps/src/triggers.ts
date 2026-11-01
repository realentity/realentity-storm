import { APPLICATION_STATUSES, isEventTrigger, isWebhookTrigger, type Trigger, type TriggerEventName } from "@ai-me/shared";
import { z } from "zod";
import { EmailMessageSchema } from "./catalog";

/** {{trigger.*}} of each event (M12-T1): what the worker puts in, and what the compiler checks references against. */
export const TRIGGER_DATA: Record<TriggerEventName, z.ZodObject> = {
  "run.finished": z.object({
    runId: z.string(),
    pipeline: z.string(),
    status: z.enum(["DONE", "FAILED"]),
    summary: z.string().nullable(),
    /** Each step's output by step id (forEach steps: the list of their items' outputs). */
    outputs: z.record(z.string(), z.unknown()),
  }),
  "application.status": z.object({
    applicationId: z.string(),
    status: z.enum(APPLICATION_STATUSES),
    job: z.object({ title: z.string(), company: z.string().nullable(), location: z.string().nullable(), url: z.string() }),
  }),
  "recipe.broken": z.object({
    site: z.string(),
    recipe: z.string(),
    version: z.number().int(),
    reason: z.string(),
    fixProposed: z.boolean(),
  }),
  "email.classified": z.object({ label: z.string(), reason: z.string(), message: EmailMessageSchema }),
  "flow.later": z.object({
    /** What the flow.later step gave. Written by a pipeline (maybe from LLM text), so never a target. */
    data: z.unknown(),
    key: z.string().nullable(),
    scheduledAt: z.string(),
    scheduledByRunId: z.string().nullable(),
  }),
};

export const WEBHOOK_DATA = z.object({
  /** The JSON body, or its text when it isn't JSON. Untrusted: anyone holding the secret wrote it. */
  body: z.unknown(),
  /** X-GitHub-Event or X-Event, when sent. */
  event: z.string().nullable(),
  receivedAt: z.string(),
});

/** {{trigger}}'s schema for a pipeline's trigger; null when it has none (manual, schedule). */
export function triggerDataSchema(trigger: Trigger): z.ZodObject | null {
  if (isEventTrigger(trigger)) return TRIGGER_DATA[trigger.on];
  if (isWebhookTrigger(trigger)) return WEBHOOK_DATA;
  return null;
}

/**
 * Which {{trigger.*}} values may be a side effect's target (README §1.4: targets come from data, never from LLM
 * text): an email's own addresses and a posting's own URL. A webhook body is written by whoever calls it, and a
 * finished run's outputs may be LLM text, so neither is.
 */
export function triggerTargetIssue(trigger: Trigger, source: string): string | null {
  if (isEventTrigger(trigger)) {
    if (trigger.on === "email.classified" && source.startsWith("trigger.message.")) return null;
    if (trigger.on === "application.status" && source === "trigger.job.url") return null;
    if (trigger.on === "flow.later") return `{{${source}}} can't be a target: a flow.later's data is written by a pipeline, maybe from LLM text`;
    return `{{${source}}} can't be a target: only an email's own addresses (email.classified) or a posting's URL (application.status) can`;
  }
  if (isWebhookTrigger(trigger)) return `{{${source}}} can't be a target: a webhook's body is written by whoever calls it`;
  return `{{${source}}} is only available in a pipeline triggered by an event or a webhook`;
}

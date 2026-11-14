import { APPLICATION_STATUSES, isEventTrigger, isWebhookTrigger, type Trigger, type TriggerEventName } from "@realentity/storm-shared";
import { z } from "zod";
import { EmailMessageSchema, TelegramFileSchema } from "./catalog";

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
  "view.action": z.object({
    collection: z.string(),
    key: z.string(),
    /** The row as data.save kept it: read from pages, feeds or emails, so never a target. */
    item: z.record(z.string(), z.unknown()),
    /** The button's label. */
    action: z.string(),
  }),
  "entity.changed": z.object({
    app: z.string(),
    type: z.string(),
    key: z.string(),
    /** The entity now: what a pipeline read from pages, feeds or emails, so never a target. Typed by the App's type. */
    item: z.record(z.string(), z.unknown()),
    /** Before the change; null when it was just added. */
    before: z.record(z.string(), z.unknown()).nullable(),
    /** The fields that changed (all of them when it was added). */
    changed: z.array(z.string()),
    by: z.enum(["pipeline", "me"]),
    /** Its stage's move in this change (M32); null when it didn't move. */
    stage: z.object({ from: z.string().nullable(), to: z.string() }).nullable(),
  }),
  "telegram.command": z.object({
    command: z.string(),
    /** What follows the command: the user's own words, data, never a target. */
    text: z.string(),
    /** A photo or a file sent with it, for file.keep's `telegram`; null without one. */
    file: TelegramFileSchema.nullable(),
    messageId: z.number().int(),
    sentAt: z.string(),
  }),
  "entity.action": z.object({
    app: z.string(),
    type: z.string(),
    key: z.string(),
    /** The entity, fields of mine over what pipelines wrote. A target only when its type is mine (M32). */
    item: z.record(z.string(), z.unknown()),
    /** The button's label. */
    action: z.string(),
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
 * Which {{trigger.*}} values may be a side effect's target (docs/design.md §1.4: targets come from data, never from LLM
 * text): an email's own addresses and a posting's own URL. A webhook body is written by whoever calls it, and a
 * finished run's outputs may be LLM text, so neither is.
 */
export function triggerTargetIssue(trigger: Trigger, source: string): string | null {
  if (isEventTrigger(trigger)) {
    if (trigger.on === "email.classified" && source.startsWith("trigger.message.")) return null;
    if (trigger.on === "application.status" && source === "trigger.job.url") return null;
    if (trigger.on === "flow.later") return `{{${source}}} can't be a target: a flow.later's data is written by a pipeline, maybe from LLM text`;
    if (trigger.on === "view.action") return `{{${source}}} can't be a target: a row holds what a pipeline read from pages, feeds or emails`;
    if (trigger.on === "telegram.command") return `{{${source}}} can't be a target: a message's text is data, not an address`;
    if (trigger.on === "entity.changed" || trigger.on === "entity.action") {
      return `{{${source}}} can't be a target: an entity holds what a pipeline read from pages, feeds or emails (only a type of mine can be)`;
    }
    return `{{${source}}} can't be a target: only an email's own addresses (email.classified) or a posting's URL (application.status) can`;
  }
  if (isWebhookTrigger(trigger)) return `{{${source}}} can't be a target: a webhook's body is written by whoever calls it`;
  return `{{${source}}} is only available in a pipeline triggered by an event or a webhook`;
}

/**
 * {{trigger}} for a dry run of a pipeline started by an event or a webhook: an example of what that event brings,
 * shaped by the trigger's own filters (its first status, label, pipeline, site). Nothing in it is real: example.com
 * addresses and "example" ids. Null for a pipeline without a trigger event (manual, schedule).
 */
export function exampleTriggerData(trigger: Trigger): Record<string, unknown> | null {
  const now = new Date().toISOString();
  if (isWebhookTrigger(trigger)) return { body: { example: true }, event: null, receivedAt: now };
  if (!isEventTrigger(trigger)) return null;
  switch (trigger.on) {
    case "run.finished":
      return {
        runId: "00000000-0000-4000-8000-00000000e001",
        pipeline: trigger.pipeline,
        status: trigger.status?.[0] ?? "DONE",
        summary: "An example run (dry run)",
        outputs: {},
      };
    case "application.status":
      return {
        applicationId: "example-application",
        status: trigger.status?.[0] ?? "SUBMITTED",
        job: { title: "Example role", company: "Example Ltd", location: "Sofia", url: "https://jobs.example.com/example-role" },
      };
    case "recipe.broken":
      return {
        site: trigger.site ?? "example.com",
        recipe: `${trigger.site ?? "example.com"}/search`,
        version: 1,
        reason: "An example: the list wasn't found (dry run)",
        fixProposed: false,
      };
    case "email.classified":
      return {
        label: trigger.label?.[0] ?? "example",
        reason: "An example email (dry run)",
        message: {
          uid: 1,
          messageId: "<example@mail.example.com>",
          threadId: "<example@mail.example.com>",
          inReplyTo: null,
          references: [],
          from: "someone@example.com",
          fromName: "Someone Example",
          replyTo: "someone@example.com",
          to: ["me@example.com"],
          cc: [],
          subject: "An example email",
          date: now,
          text: "This is an example email for a dry run. Nothing in it is real.",
          attachments: [],
        },
      };
    case "flow.later":
      return { data: {}, key: null, scheduledAt: now, scheduledByRunId: null };
    case "view.action":
      return {
        collection: trigger.collection ?? "example",
        key: "example",
        item: { id: "example", title: "An example row (dry run)", url: "https://example.com/example" },
        action: "Example",
      };
    case "entity.changed":
      return {
        app: "Example",
        type: trigger.type,
        key: "example",
        item: {},
        before: null,
        changed: trigger.field ? [trigger.field] : [],
        by: "pipeline",
        stage: trigger.stage ? { from: null, to: trigger.stage } : null,
      };
    case "entity.action":
      return { app: "Example", type: trigger.type ?? "Example", key: "example", item: {}, action: "Example" };
    case "telegram.command":
      return { command: trigger.command, text: "An example message (dry run)", file: null, messageId: 1, sentAt: now };
  }
}

import { defaultTimeZone, isTimeZone } from "./time-zone";
import { z } from "zod";
import { APP_NAME, ENTITY_FIELD, TYPE_NAME } from "./app";
import { HOST_PATTERN } from "./credentials";
import { APPLICATION_STATUSES } from "./jobs-api";
import { PipelineViewSchema, VIEW_COLLECTION } from "./view";

/**
 * Pipeline definition (docs/design.md §2.2): what a pipeline is authored as (YAML or JSON) before compilation.
 * This schema checks structure only. Step inputs (`with`) are checked by the compiler in @realentity/storm-steps against the
 * step catalog, because they may contain {{references}} to earlier steps.
 */

/** Step ids are used in references ({{search.items}}), so no dots; `item`, `cred` and `trigger` are reserved. */
export const STEP_ID = /^[a-z][a-zA-Z0-9_]{0,39}$/;
export const RESERVED_STEP_IDS = ["item", "cred", "trigger"] as const;

/** A reference: {{step.field.sub}}, {{item.field}} (inside forEach) or {{cred:name}} (credential, resolved by the worker). */
export const REFERENCE = /\{\{\s*([^{}]+?)\s*\}\}/g;
/** A value that is exactly one reference, so it passes the referenced value as it is (not as text). */
export const WHOLE_REFERENCE = /^\{\{\s*([^{}]+?)\s*\}\}$/;

/** Five-field cron: minute hour day-of-month month day-of-week. */
const CRON = /^(\S+\s+){4}\S+$/;


/** What happens in Storm that can start a pipeline (M12-T1); the event's data is {{trigger.*}} in its steps. */
export const TRIGGER_EVENTS = [
  "run.finished",
  "application.status",
  "recipe.broken",
  "email.classified",
  "flow.later",
  "view.action",
  "entity.changed",
  "entity.action",
  "telegram.command",
] as const;

/** M49: a Telegram command's name, as Telegram takes it: lowercase letters, digits and _, at most 32. */
export const TELEGRAM_COMMAND = /^[a-z0-9_]{1,32}$/;

/** M49: the Storm bot's own commands, with what they do; a pipeline's command is never one of them. */
export const BUILT_IN_COMMANDS: readonly { command: string; description: string }[] = [
  { command: "run", description: "Start a pipeline: /run <pipeline>" },
  { command: "status", description: "What runs, what waits" },
  { command: "inbox", description: "The proposals waiting for you" },
  { command: "pause", description: "Kill switch on: nothing runs or acts" },
  { command: "resume", description: "Kill switch off" },
  { command: "new", description: "A new chat with the pipeline builder" },
  { command: "edit", description: "Change a pipeline with the builder: /edit <pipeline>" },
  { command: "help", description: "What the bot does" },
  { command: "start", description: "What the bot does" },
];
export type TriggerEventName = (typeof TRIGGER_EVENTS)[number];

const list = <T extends z.ZodType>(schema: T) => z.array(schema).min(1).optional();

export const EventTriggerSchema = z.discriminatedUnion("on", [
  z
    .object({
      on: z.literal("run.finished"),
      /** The pipeline whose runs start this one, by name. */
      pipeline: z.string().trim().min(1).max(100),
      /** Default: only runs that finished DONE. */
      status: list(z.enum(["DONE", "FAILED"])),
    })
    .strict(),
  z.object({ on: z.literal("application.status"), status: list(z.enum(APPLICATION_STATUSES)) }).strict(),
  z.object({ on: z.literal("recipe.broken"), site: z.string().trim().toLowerCase().min(1).optional() }).strict(),
  /** One event per email an email.classify step labelled; `label` filters them. */
  z.object({ on: z.literal("email.classified"), label: list(z.string().min(1)) }).strict(),
  /** Started by another pipeline's flow.later (M14-T3), with the data it gave: {{trigger.data}}. */
  z.object({ on: z.literal("flow.later") }).strict(),
  /** Started by a row's button on a pipeline's page (M27), with the row: {{trigger.item}}. `collection` limits it to one. */
  z.object({ on: z.literal("view.action"), collection: z.string().regex(VIEW_COLLECTION).optional() }).strict(),
  /**
   * An entity of the pipeline's App was added or changed (M30): by another pipeline's data.save, or by the user (M32).
   * `field` limits it to changes of that field.
   */
  z
    .object({
      on: z.literal("entity.changed"),
      type: z.string().regex(TYPE_NAME),
      field: z.string().regex(ENTITY_FIELD).optional(),
      /** Only a move into this stage (M32). */
      stage: z.string().trim().min(1).max(40).optional(),
    })
    .strict(),
  /** An entity's button on its page (M32), with the entity: {{trigger.item}}. `type` limits it to one. */
  z.object({ on: z.literal("entity.action"), type: z.string().regex(TYPE_NAME).optional() }).strict(),
  /**
   * M49: a command sent to the Storm bot, /task Buy milk: {{trigger.text}} is what follows it, {{trigger.file}} a photo
   * or a file sent with it (the command as its caption). Only from the user's own chat, and only while the pipeline is
   * on; one pipeline per command (refused when switching on a second).
   */
  z
    .object({
      on: z.literal("telegram.command"),
      command: z.string().regex(TELEGRAM_COMMAND, "lowercase letters, digits and _, at most 32, e.g. task"),
      /** In the bot's menu. */
      description: z.string().trim().min(3).max(200).optional(),
    })
    .strict()
    .refine((t) => !BUILT_IN_COMMANDS.some((b) => b.command === t.command), { message: "that is one of the Storm bot's own commands", path: ["command"] }),
]);
export type EventTrigger = z.infer<typeof EventTriggerSchema>;

/**
 * A call from the Internet (M12-T2): `hmac-sha256` checks a GitHub-style X-Hub-Signature-256 over the body,
 * `token` an Authorization: Bearer header. The body is {{trigger.body}}.
 */
export const WebhookTriggerSchema = z.object({ webhook: z.enum(["hmac-sha256", "token"]) }).strict();
export type WebhookTrigger = z.infer<typeof WebhookTriggerSchema>;

export const ScheduleTriggerSchema = z.object({
  schedule: z.string().trim().regex(CRON, 'a five-field cron expression, e.g. "0 8 * * 1-5"'),
  /** Without one: the server's zone (TZ), see defaultTimeZone. */
  tz: z.string().default(defaultTimeZone).refine(isTimeZone, "an IANA time zone, e.g. Europe/London"),
});

export const TriggerSchema = z.union([z.literal("manual"), ScheduleTriggerSchema, EventTriggerSchema, WebhookTriggerSchema]);
export type Trigger = z.infer<typeof TriggerSchema>;

export function isEventTrigger(trigger: Trigger): trigger is EventTrigger {
  return typeof trigger === "object" && "on" in trigger;
}

export function isWebhookTrigger(trigger: Trigger): trigger is WebhookTrigger {
  return typeof trigger === "object" && "webhook" in trigger;
}

export const PipelineStepSchema = z
  .object({
    id: z
      .string()
      .regex(STEP_ID, "letters, digits and _, starting with a lowercase letter (max 40)")
      .refine((id) => !(RESERVED_STEP_IDS as readonly string[]).includes(id), "is reserved"),
    type: z.string().regex(/^[a-z]+\.[a-zA-Z]+$/, "a step type from the catalog, e.g. llm.score"),
    forEach: z.string().regex(WHOLE_REFERENCE, 'a single reference to a list, e.g. "{{search.items}}"').optional(),
    /**
     * Runs the step only when this value isn't empty: a non-empty list or text, true, a number other than 0, an
     * object (M13). Otherwise it is skipped, and so is every later step that uses its output.
     */
    when: z.string().regex(WHOLE_REFERENCE, 'a single reference, e.g. "{{save.added}}"').optional(),
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
    /** The App it belongs to (M30), by name: its steps write, read and watch that App's types. */
    app: z.string().trim().regex(APP_NAME).optional(),
    trigger: TriggerSchema.default("manual"),
    steps: z.array(PipelineStepSchema).min(1).max(50),
    limits: z.record(z.string(), z.string().regex(LIMIT, '"N/day" or "N/hour"')).default({}),
    policy: PipelinePolicySchema.default({ allowedDomains: [], allowedRecipients: [] }),
    /** Its page (M27): the collection it saves, in the menu, as a list with the user's marks and buttons. */
    view: PipelineViewSchema.optional(),
  })
  .strict();
export type PipelineDefinition = z.infer<typeof PipelineDefinitionSchema>;

/** A step after compilation: defaults applied, and marked when the compiler inserted it (gates). */
export interface CompiledStep extends PipelineStep {
  autoInserted?: boolean;
}

export interface CompiledDefinition extends Omit<PipelineDefinition, "steps"> {
  steps: CompiledStep[];
  /** M39-T2: what it names, by id, as resolved when it was saved. Absent in versions saved before M39. */
  refs?: DefinitionRefs;
}

/**
 * M39-T2: the App and the pipelines a definition names (`app:`, run.finished's `pipeline`, flow.later's `pipeline`),
 * by id: what runs it uses, so a rename breaks nothing. The names stay in the definition, as written.
 */
export interface DefinitionRefs {
  appId?: string;
  /** A pipeline's name as written → its id. A name with no pipeline yet isn't in it: looked up by name when it runs. */
  pipelines: Record<string, string>;
}

/** M39-T2: the pipelines a definition names: run.finished's trigger, flow.later's steps (a written name, not a template). */
export function namedPipelines(definition: Pick<PipelineDefinition, "trigger" | "steps">): string[] {
  const names = new Set<string>();
  const trigger = definition.trigger;
  if (typeof trigger === "object" && "on" in trigger && trigger.on === "run.finished") names.add(trigger.pipeline);
  for (const step of definition.steps) {
    const target = step.type === "flow.later" ? step.with?.pipeline : undefined;
    if (typeof target === "string" && !target.includes("{{")) names.add(target);
  }
  return [...names];
}

/** What side-effect steps may target, enforced at run time (docs/design.md §2.2 "Policy"). */
export interface CompiledPolicy {
  /** Static allowlists: the definition's policy plus literal targets found in steps. */
  allowedDomains: string[];
  allowedRecipients: string[];
  /** Targets that must come from an earlier step's actual output, never from LLM text. */
  provenance: ProvenanceRule[];
  /**
   * M47: the ids of the checks (http.check, net.check) whose address is a field of mine of an App entity, which the
   * user typed: only these may reach a private, LAN or Tailscale address. Set by the compiler alone.
   */
  privateHosts?: string[];
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

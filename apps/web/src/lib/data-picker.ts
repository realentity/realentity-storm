import { type AppDefinition, type JsonSchema, type StepTypeView, type TriggerDataView } from "@ai-me/shared";
import { resolve } from "./schema-form";
import { type LoosePipeline } from "./step-cards";

/**
 * M36-T4: the data picker. For one input of one step, what it may be given: the trigger's data and the outputs of the
 * steps before it (and inside a forEach, its item), each of a kind that fits the input. For a side effect's target, only
 * what the compiler lets be one: never an LLM's text, a webhook's body or an entity a pipeline wrote (README §2.2).
 * The compiler still decides; the picker only doesn't offer what it would refuse.
 */

export type DataKind = "text" | "number" | "boolean" | "list" | "object" | "any";

export interface Offer {
  /** What is written: {{fetch.messages}}. */
  reference: string;
  /** Where it comes from: "Trigger", "fetch (email.fetch)", "Each item". */
  group: string;
  kind: DataKind;
  description?: string;
}

export interface PickerContext {
  pipeline: LoosePipeline;
  catalog: StepTypeView[];
  triggers: TriggerDataView | null;
  /** The App the pipeline names, for entity triggers and data.read's items. */
  app: AppDefinition | null;
}

/** A schema's kind. */
export function kindOf(schema: JsonSchema | undefined): DataKind {
  const s = resolve(schema);
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
  if (type === "string") return "text";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "array") return "list";
  if (type === "object") return "object";
  return "any";
}

/** Does a value of this kind fit an input of that one? Text takes numbers and yes/no too (written into it). */
export function fits(input: DataKind, value: DataKind): boolean {
  if (input === "any" || value === "any") return true;
  if (input === "text") return value === "text" || value === "number" || value === "boolean";
  return input === value;
}

const FIELD_KIND: Record<string, DataKind> = {
  text: "text",
  longtext: "text",
  url: "text",
  email: "text",
  date: "text",
  datetime: "text",
  enum: "text",
  number: "number",
  money: "number",
  yesno: "boolean",
  list: "list",
};

/** An App type's fields as a schema's properties, the stage among them. */
function typeProperties(app: AppDefinition | null, type: unknown): Record<string, JsonSchema> | null {
  if (!app || typeof type !== "string" || !Object.hasOwn(app.types, type)) return null;
  const kinds: Record<DataKind, string> = {
    text: "string",
    number: "number",
    boolean: "boolean",
    list: "array",
    object: "object",
    any: "",
  };
  return Object.fromEntries(
    Object.entries(app.types[type].fields).map(([name, field]) => [
      name,
      { type: kinds[FIELD_KIND[field.type] ?? "text"] || undefined, description: field.label },
    ]),
  );
}

interface Source {
  /** The reference's root: a step id, "trigger" or "item". */
  root: string;
  group: string;
  schema: JsonSchema;
  /** May any of it be a side effect's target? A list of the fields that may, or all/none. */
  target: "all" | "none" | ((path: string) => boolean);
}

/** The step types whose output holds entities a pipeline wrote, by App type: never targets unless the type is mine. */
function readType(step: { type: string; with: Record<string, unknown> }): unknown {
  return step.type === "data.read" ? step.with.type : undefined;
}

function sources(ctx: PickerContext, stepIndex: number): Source[] {
  const { pipeline, catalog, triggers, app } = ctx;
  const byType = new Map(catalog.map((s) => [s.type, s]));
  const list: Source[] = [];

  // The trigger's data.
  const trigger = pipeline.trigger;
  if (trigger && typeof trigger === "object" && triggers) {
    const t = trigger as Record<string, unknown>;
    let schema: JsonSchema | undefined;
    if (typeof t.on === "string") schema = triggers.events[t.on];
    else if ("webhook" in t) schema = triggers.webhook;
    if (schema) {
      const entity = (t.on === "entity.changed" || t.on === "entity.action") && typeof t.type === "string" ? t.type : null;
      const item = entity ? typeProperties(app, entity) : null;
      const withItem: JsonSchema = item
        ? { ...schema, properties: { ...schema.properties, item: { type: "object", properties: item, description: `the ${entity}` } } }
        : schema;
      const mine = entity && app?.types[entity]?.mine === true;
      list.push({
        root: "trigger",
        group: "Trigger",
        schema: withItem,
        target: (path) =>
          (t.on === "email.classified" && path.startsWith("trigger.message.")) ||
          (t.on === "application.status" && path === "trigger.job.url") ||
          (mine === true && path.startsWith("trigger.item.")),
      });
    }
  }

  // The steps before this one.
  for (const step of pipeline.steps.slice(0, stepIndex)) {
    const definition = byType.get(step.type);
    if (!definition || !step.id) continue;
    let schema = definition.output;
    const type = readType(step);
    const item = typeProperties(app, type);
    if (item && schema.properties?.items) {
      schema = { ...schema, properties: { ...schema.properties, items: { type: "array", items: { type: "object", properties: item } } } };
    }
    const wrote = item && app?.types[type as string]?.mine !== true;
    list.push({
      root: step.id,
      group: `${step.id} (${step.type})`,
      schema,
      target: definition.llmOutput ? (path) => definition.pageFields.some((f) => path === `${step.id}.${f}`) : wrote ? "none" : "all",
    });
  }
  return list;
}

/** A source's references: its fields, and theirs one level down (trigger.message.from), with their kinds. */
function walk(
  root: string,
  schema: JsonSchema,
  depth: number,
): { path: string; kind: DataKind; description?: string; schema: JsonSchema }[] {
  const out: { path: string; kind: DataKind; description?: string; schema: JsonSchema }[] = [];
  for (const [name, property] of Object.entries(resolve(schema).properties ?? {})) {
    const path = `${root}.${name}`;
    const s = resolve(property);
    out.push({ path, kind: kindOf(s), description: s.description, schema: s });
    if (depth > 0 && kindOf(s) === "object" && s.properties) out.push(...walk(path, s, depth - 1));
  }
  return out;
}

/**
 * What an input may be given. `input` is a field of the step's `with`, or ":when" / ":forEach" for those. `target`:
 * the input names a side effect's target.
 */
export function offersFor(ctx: PickerContext, stepIndex: number, input: string): Offer[] {
  const step = ctx.pipeline.steps[stepIndex];
  if (!step) return [];
  const definition = ctx.catalog.find((s) => s.type === step.type);
  const want: DataKind = input === ":forEach" ? "list" : input === ":when" ? "any" : kindOf(definition?.input.properties?.[input]);
  const target = !input.startsWith(":") && definition !== undefined && input in definition.targets;
  const all = sources(ctx, stepIndex);
  const offers: Offer[] = [];
  const add = (path: string, kind: DataKind, group: string, allowed: Source["target"], description?: string) => {
    if (!fits(want, kind)) return;
    if (target && (allowed === "none" || (typeof allowed === "function" && !allowed(path)))) return;
    offers.push({ reference: `{{${path}}}`, group, kind, description });
  };

  for (const source of all) {
    for (const r of walk(source.root, source.schema, source.root === "trigger" ? 2 : 1))
      add(r.path, r.kind, source.group, source.target, r.description);
  }

  // Inside a forEach: the item, and its fields when the list says what its items are.
  const forEach = /^\{\{\s*([^{}]+?)\s*\}\}$/.exec(step.forEach ?? "")?.[1];
  if (forEach && input !== ":forEach") {
    const [root, ...rest] = forEach.split(".");
    const source = all.find((s) => s.root === root);
    let schema: JsonSchema | undefined = source?.schema;
    for (const part of rest) schema = schema ? resolve(resolve(schema).properties?.[part]) : undefined;
    const items = schema ? resolve(resolve(schema).items) : undefined;
    // The item may be a target when the list's own fields may be.
    const allowed: Source["target"] = !source
      ? "none"
      : typeof source.target === "function"
        ? (path) => (source.target as (p: string) => boolean)(path.replace(/^item/, forEach))
        : source.target;
    add("item", items ? kindOf(items) : "any", "Each item", allowed);
    if (items) for (const r of walk("item", items, 1)) add(r.path, r.kind, "Each item", allowed, r.description);
  }
  return offers;
}

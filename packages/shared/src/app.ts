import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { safeLink, VIEW_ICONS } from "./view";

/**
 * An App (M30): what belongs together (Job Search, Bills), with its data types. Its pipelines say `app: <name>` and
 * write, read and watch entities of its types; the compiler checks them against the App's current version.
 */

/** "Job Search": how pipelines refer to it. */
export const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/;
/** "Job": a type's name, by which pipelines write and read it. */
export const TYPE_NAME = /^[A-Z][A-Za-z0-9]{0,39}$/;
/** A field of an entity by dotted path ("salary", "company.name"), as M27's columns. */
export const ENTITY_FIELD = /^[A-Za-z_][\w-]{0,63}(\.[A-Za-z_][\w-]{0,63}){0,3}$/;

export const FIELD_KINDS = ["text", "longtext", "number", "money", "date", "datetime", "url", "email", "yesno", "enum", "list"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/** Kinds a key can be: one that names the entity as text. */
const KEY_KINDS: readonly FieldKind[] = ["text", "url", "email", "number"];

export const EntityFieldSchema = z
  .object({
    type: z.enum(FIELD_KINDS),
    label: z.string().trim().min(1).max(40).optional(),
    required: z.boolean().default(false),
    /** Set by me (M32's forms); a pipeline never writes it. */
    mine: z.boolean().default(false),
    /** enum: the values it may take. */
    values: z.array(z.string().trim().min(1).max(60)).min(1).max(50).optional(),
    /** money: the field holding the currency code. */
    currency: z.string().regex(ENTITY_FIELD).optional(),
  })
  .strict();
export type EntityField = z.output<typeof EntityFieldSchema>;

export const STAGE_ACTORS = ["me", "pipeline"] as const;
export type StageActor = (typeof STAGE_ACTORS)[number];
const STATE = z.string().trim().min(1).max(40);

/**
 * An entity's stage (M32): where it is (new, applied, interview…), moved only as `moves` allow and by whom: me on its
 * page, or a pipeline's data.save. The date it first reached each state is kept.
 */
export const StagesSchema = z
  .object({
    /** The field that holds it, e.g. status: not one of `fields`, an enum of `states` for pages and pipelines. */
    field: z.string().regex(/^[A-Za-z_][\w-]{0,63}$/, 'a field name, e.g. "status"'),
    label: z.string().trim().min(1).max(40).optional(),
    initial: STATE,
    states: z.array(STATE).min(2).max(20),
    moves: z
      .array(
        z
          .object({
            from: z.union([STATE, z.array(STATE).min(1)]),
            to: z.array(STATE).min(1),
            /** Default: only me, on its page. */
            by: z.array(z.enum(STAGE_ACTORS)).min(1).default(["me"]),
          })
          .strict(),
      )
      .min(1)
      .max(40),
  })
  .strict();
export type Stages = z.output<typeof StagesSchema>;

/** Can `by` move an entity from `from` to `to`? */
export function canMove(stages: Stages, from: string, to: string, by: StageActor): boolean {
  return stages.moves.some((move) => (Array.isArray(move.from) ? move.from : [move.from]).includes(from) && move.to.includes(to) && move.by.includes(by));
}

/** Where `by` may move an entity from its stage, in the order of `states`. */
export function movesFrom(stages: Stages, from: string, by: StageActor): string[] {
  return stages.states.filter((to) => to !== from && canMove(stages, from, to, by));
}

export const DataTypeSchema = z
  .object({
    description: z.string().max(500).optional(),
    /** A type I write (M32), on its pages' forms: things to watch, people. Pipelines only read it. */
    mine: z.boolean().default(false),
    stages: StagesSchema.optional(),
    /** The field that identifies an entity: one per key, as data.save's key. */
    key: z.string().regex(ENTITY_FIELD),
    /** The entity's name on its page; default: the key. */
    title: z.string().regex(ENTITY_FIELD).optional(),
    fields: z
      .record(z.string().regex(ENTITY_FIELD, 'a field name, e.g. "salary" or "company.name"'), EntityFieldSchema)
      .refine((fields) => Object.keys(fields).length >= 1, "at least one field")
      .refine((fields) => Object.keys(fields).length <= 60, "at most 60 fields"),
  })
  .strict()
  .superRefine((type, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const names = Object.keys(type.fields);
    const key = type.fields[type.key];
    if (!key) issue(["key"], `"${type.key}" is not one of the fields`);
    else if (!KEY_KINDS.includes(key.type)) issue(["key"], `a key is text, a url, an email or a number, not ${key.type}`);
    else if (key.mine) issue(["key"], "the key is written by pipelines, so it can't be mine");
    if (type.title && !type.fields[type.title]) issue(["title"], `"${type.title}" is not one of the fields`);
    for (const [name, field] of Object.entries(type.fields)) {
      const at = ["fields", name];
      if (names.some((other) => other.startsWith(`${name}.`))) issue(at, `"${name}" can't be a field and hold fields too`);
      if (field.type === "enum" && !field.values) issue([...at, "values"], "an enum needs its values");
      if (field.type !== "enum" && field.values) issue([...at, "values"], "only an enum has values");
      if (field.currency !== undefined) {
        if (field.type !== "money") issue([...at, "currency"], "only money has a currency");
        else if (type.fields[field.currency]?.type !== "text")
          issue([...at, "currency"], `"${field.currency}" is not a text field of this type`);
      }
      if (field.mine && field.required && !type.mine) issue([...at, "required"], "a field of mine can't be required: pipelines write the entity first");
    }
    if (type.stages) {
      const { field, initial, states, moves } = type.stages;
      const state = (value: string, path: (string | number)[]) => {
        if (!states.includes(value)) issue(["stages", ...path], `"${value}" is not one of the states`);
      };
      // Parsing a parsed type again finds the stage's own field (added below): that one is fine.
      const own = type.fields[field];
      const isOwn = own?.type === "enum" && JSON.stringify(own.values) === JSON.stringify(states) && !own.mine && !own.required;
      if (own && !isOwn) issue(["stages", "field"], `"${field}" is already a field: the stage gets its own`);
      if (new Set(states).size !== states.length) issue(["stages", "states"], "each state once");
      state(initial, ["initial"]);
      moves.forEach((move, i) => {
        (Array.isArray(move.from) ? move.from : [move.from]).forEach((from) => state(from, ["moves", i, "from"]));
        move.to.forEach((to, j) => state(to, ["moves", i, "to", j]));
        if (type.mine && move.by.includes("pipeline")) issue(["stages", "moves", i, "by"], "pipelines don't write a type of mine");
      });
    }
  })
  // The stage as an enum field of its states, so pages filter and pipelines read it like any other.
  .transform((type) =>
    type.stages
      ? {
          ...type,
          fields: {
            ...type.fields,
            [type.stages.field]: {
              type: "enum" as const,
              values: type.stages.states,
              required: false,
              mine: false,
              ...(type.stages.label ? { label: type.stages.label } : {}),
            },
          },
        }
      : type,
  );
export type DataType = z.output<typeof DataTypeSchema>;

/** What AI ME knows of every entity besides its fields: a list may show, sort and group by them. */
export const ENTITY_META = ["@firstSeen", "@lastSeen"] as const;
const PageField = z.union([z.enum(ENTITY_META), z.string().regex(ENTITY_FIELD, 'a field of the type, e.g. "salary"')]);
const PageMenu = z.object({ label: z.string().trim().min(1).max(30), icon: z.enum(VIEW_ICONS).optional() }).strict();
/** A button (M32): starts a pipeline by name; `confirm` is asked first. */
const PageAction = z
  .object({
    label: z.string().trim().min(1).max(30),
    run: z.string().trim().min(1).max(100),
    confirm: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

/** Field values an entity must have: one, or one of a list (a button's `when`, a total's, a due date's `unless`). */
const Conditions = z.record(z.string().regex(ENTITY_FIELD), z.union([z.string().max(60), z.boolean(), z.array(z.string().max(60)).min(1)]));

/**
 * An entity's button (M32): starts a pipeline triggered by { on: entity.action } with the entity. `when`: only while
 * its fields have these values (one, or one of a list), e.g. { status: favorite }.
 */
const EntityAction = PageAction.extend({
  when: Conditions.optional(),
}).strict();
export type EntityActionDef = z.output<typeof EntityAction>;

const PageSort = z.string().regex(/^-?(@firstSeen|@lastSeen|[A-Za-z_][\w.-]*)$/, '"field" or "-field", e.g. -salary');

/**
 * A type's list page (M31): in the menu under Pages, its columns, filters, search, sort and groups with totals. A
 * field's format comes from its kind. Anything left out has a default from the type's fields.
 */
export const ListPageSchema = z
  .object({
    list: z.string().regex(TYPE_NAME),
    /** In the menu; false: reached from the App only. Default: the type's name. */
    menu: z.union([PageMenu, z.literal(false)]).optional(),
    columns: z
      .array(
        z.union([
          PageField,
          z
            .object({
              field: PageField,
              label: z.string().trim().min(1).max(40).optional(),
              /** A date field (M33): a badge when it is past, today or within `days`, unless the entity is as `unless` says. */
              due: z.object({ days: z.number().int().min(0).max(60).default(3), unless: Conditions.optional() }).strict().optional(),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(8)
      .optional(),
    /** Fields to filter by: enum and yes/no ones, picked from their values. */
    filters: z.array(z.string().regex(ENTITY_FIELD)).max(6).optional(),
    /** Fields the search box looks in; default: the text fields. */
    search: z.array(z.string().regex(ENTITY_FIELD)).min(1).max(10).optional(),
    sort: PageSort.optional(),
    /** Rows in groups, with counts and totals: by a field, or a date field's month or year. */
    group: z
      .object({
        by: PageField,
        period: z.enum(["month", "year"]).optional(),
        /**
         * Number or money fields summed per group (money per currency); `when` sums only the entities that are as it
         * says, e.g. { field: amount, label: Unpaid, when: { status: due } } (M33).
         */
        totals: z
          .array(
            z.union([
              z.string().regex(ENTITY_FIELD),
              z.object({ field: z.string().regex(ENTITY_FIELD), label: z.string().trim().min(1).max(40).optional(), when: Conditions.optional() }).strict(),
            ]),
          )
          .max(4)
          .default([]),
      })
      .strict()
      .optional(),
    /** A Removed tab: entities a complete save no longer had. */
    removed: z.boolean().default(false),
    /** Buttons above the list (M32): each starts a pipeline that is manual or scheduled, as a manual run. */
    actions: z.array(PageAction).max(4).default([]),
    /** Each row's stage moves (mine) as buttons on the row, e.g. Mark paid (M33). */
    moves: z.boolean().default(false),
    /**
     * A data.history collection keyed by the entities' keys, drawn above the list (M33, as M29-T8's): a line per key,
     * the five with the highest latest value; `stepped` for prices.
     */
    chart: z
      .object({
        history: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
        label: z.string().trim().min(1).max(40).optional(),
        stepped: z.boolean().default(false),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ListPage = z.output<typeof ListPageSchema>;

/** An entity's own page (M31): its fields (in sections), and a data.history collection by its key as a chart. */
export const ViewPageSchema = z
  .object({
    view: z.string().regex(TYPE_NAME),
    fields: z.array(PageField).min(1).max(40).optional(),
    sections: z
      .array(z.object({ title: z.string().trim().min(1).max(40), fields: z.array(PageField).min(1).max(40) }).strict())
      .min(1)
      .max(6)
      .optional(),
    history: z
      .object({
        collection: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
        label: z.string().trim().min(1).max(40).optional(),
        stepped: z.boolean().default(false),
      })
      .strict()
      .optional(),
    actions: z.array(EntityAction).max(6).default([]),
  })
  .strict();
export type ViewPage = z.output<typeof ViewPageSchema>;

/** The form on an entity's page (M32): which of my fields, in what order; default all of them. */
export const FormPageSchema = z
  .object({
    form: z.string().regex(TYPE_NAME),
    fields: z.array(z.string().regex(ENTITY_FIELD)).min(1).max(40).optional(),
  })
  .strict();
export type FormPage = z.output<typeof FormPageSchema>;

export const AppPageSchema = z.union([ListPageSchema, ViewPageSchema, FormPageSchema]);
export type AppPage = z.output<typeof AppPageSchema>;

export const AppDefinitionSchema = z
  .object({
    name: z.string().trim().regex(APP_NAME, "letters, digits, spaces, . _ - (max 60)"),
    description: z.string().max(2000).optional(),
    icon: z.enum(VIEW_ICONS).default("list"),
    types: z
      .record(z.string().regex(TYPE_NAME, 'a type name, e.g. "Job": a capital letter, then letters and digits'), DataTypeSchema)
      .refine((types) => Object.keys(types).length >= 1, "at least one type")
      .refine((types) => Object.keys(types).length <= 20, "at most 20 types"),
    /** M31: list and view pages; a type without one gets a default from its fields. */
    pages: z.array(AppPageSchema).max(40).default([]),
  })
  .strict()
  .superRefine((app, ctx) => checkPages(app, (path, message) => ctx.addIssue({ code: "custom", path, message })));
export type AppDefinition = z.output<typeof AppDefinitionSchema>;

const FILTER_KINDS: readonly FieldKind[] = ["enum", "yesno"];
const SEARCH_KINDS: readonly FieldKind[] = ["text", "longtext", "email", "url", "enum"];
const TOTAL_KINDS: readonly FieldKind[] = ["number", "money"];
const PERIOD_KINDS: readonly FieldKind[] = ["date", "datetime"];

/** Pages only on the App's types, and only on their fields, each used as its kind allows. */
function checkPages(app: { types: Record<string, DataType>; pages: AppPage[] }, issue: (path: (string | number)[], message: string) => void): void {
  const seen = new Set<string>();
  app.pages.forEach((page, i) => {
    const kind = "list" in page ? "list" : "view" in page ? "view" : "form";
    const typeName = "list" in page ? page.list : "view" in page ? page.view : page.form;
    const at = ["pages", i];
    const type = Object.hasOwn(app.types, typeName) ? app.types[typeName] : undefined;
    if (!type) return issue([...at, kind], `there is no type "${typeName}"`);
    // The stage's field is added to the fields once the type is valid; until then (a problem elsewhere in it) it is
    // still an enum here, so a page using it isn't one more problem.
    const kindOf = (field: string) =>
      field.startsWith("@") ? "datetime" : field === type.stages?.field ? (type.fields[field]?.type ?? "enum") : type.fields[field]?.type;
    const field = (name: string, path: (string | number)[], kinds?: readonly FieldKind[], what?: string) => {
      const kind = kindOf(name);
      if (!kind) issue(path, `${typeName} has no field "${name}"`);
      else if (kinds && !kinds.includes(kind)) issue(path, `${what}: "${name}" is ${kind}`);
    };
    const key = `${kind}:${typeName}`;
    if (seen.has(key)) issue(at, `${typeName} already has a ${kind} page`);
    seen.add(key);
    const labels = new Set<string>();
    const actions = "list" in page || "view" in page ? page.actions : [];
    actions.forEach((action, j) => {
      if (labels.has(action.label)) issue([...at, "actions", j, "label"], `"${action.label}" is used by an earlier button`);
      labels.add(action.label);
      const when = "when" in action ? (action as EntityActionDef).when : undefined;
      for (const name of Object.keys(when ?? {})) field(name, [...at, "actions", j, "when", name]);
    });
    if ("form" in page) {
      for (const [j, name] of (page.fields ?? []).entries()) {
        field(name, [...at, "fields", j]);
        if (type.fields[name] && !isMineField(type, name)) issue([...at, "fields", j], `${typeName}.${name} is written by pipelines: a form edits my fields`);
      }
      return;
    }
    if ("list" in page) {
      page.columns?.forEach((c, j) => {
        if (typeof c === "string") return field(c, [...at, "columns", j]);
        field(c.field, [...at, "columns", j], c.due ? PERIOD_KINDS : undefined, "a due badge is on a date field");
        for (const name of Object.keys(c.due?.unless ?? {})) field(name, [...at, "columns", j, "due", "unless", name]);
      });
      if (page.moves && !type.stages) issue([...at, "moves"], `${typeName} has no stages to move`);
      page.filters?.forEach((f, j) => field(f, [...at, "filters", j], FILTER_KINDS, "a filter is an enum or a yes/no field"));
      page.search?.forEach((f, j) => field(f, [...at, "search", j], SEARCH_KINDS, "search looks in text fields"));
      if (page.sort) field(page.sort.replace(/^-/, ""), [...at, "sort"]);
      if (page.group) {
        field(page.group.by, [...at, "group", "by"]);
        if (page.group.period) field(page.group.by, [...at, "group", "period"], PERIOD_KINDS, "a period groups a date field");
        page.group.totals.forEach((t, j) => {
          field(typeof t === "string" ? t : t.field, [...at, "group", "totals", j], TOTAL_KINDS, "a total is a number or money field");
          if (typeof t !== "string") for (const name of Object.keys(t.when ?? {})) field(name, [...at, "group", "totals", j, "when", name]);
        });
      }
    } else if ("view" in page) {
      page.fields?.forEach((f, j) => field(f, [...at, "fields", j]));
      page.sections?.forEach((section, j) => section.fields.forEach((f, k) => field(f, [...at, "sections", j, "fields", k])));
      if (page.fields && page.sections) issue([...at, "sections"], "fields or sections, not both");
    }
  });
}

/**
 * A saved App version's definition, from the YAML it was saved as: a version's JSON copy is jsonb, which reorders keys,
 * and the order of the fields is the order I wrote them in (columns, forms).
 */
export function readAppSource(source: string): AppDefinition {
  return AppDefinitionSchema.parse(parseYaml(source));
}

/** A field I set on a form: one marked mine, or any of a type of mine, never the stage (moved by its buttons). */
export function isMineField(type: DataType, name: string): boolean {
  if (type.stages?.field === name) return false;
  return type.mine ? name in type.fields : type.fields[name]?.mine === true;
}

/** A field's value by dotted path; undefined when missing. */
export function entityValueAt(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function setAt(value: Record<string, unknown>, path: string, next: unknown): void {
  const segments = path.split(".");
  let current = value;
  for (const segment of segments.slice(0, -1)) {
    const inner = current[segment];
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) current[segment] = {};
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]] = next;
}

function deleteAt(value: Record<string, unknown>, path: string): void {
  const segments = path.split(".");
  const parent = entityValueAt(value, segments.slice(0, -1).join("."));
  if (segments.length === 1) delete value[path];
  else if (parent && typeof parent === "object" && !Array.isArray(parent)) delete (parent as Record<string, unknown>)[segments.at(-1)!];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A value as the field's kind, or why it isn't one. Text that holds a number or a date is read as one. */
export function fieldValue(field: EntityField, value: unknown): { ok: true; value: unknown } | { ok: false; problem: string } {
  const text = typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
  switch (field.type) {
    case "text":
    case "longtext":
      return text !== null
        ? { ok: true, value: text.slice(0, field.type === "text" ? 1000 : 50_000) }
        : { ok: false, problem: "isn't text" };
    case "number":
    case "money": {
      const number = typeof value === "number" ? value : text !== null && text !== "" ? Number(text.replace(/[\s,](?=\d{3}\b)/g, "")) : NaN;
      return Number.isFinite(number) ? { ok: true, value: number } : { ok: false, problem: "isn't a number" };
    }
    case "date":
    case "datetime": {
      if (text === null || text === "" || !/^\d{4}-\d{2}-\d{2}/.test(text)) return { ok: false, problem: "isn't a date (2026-11-03)" };
      const date = new Date(text);
      if (Number.isNaN(date.getTime())) return { ok: false, problem: "isn't a date (2026-11-03)" };
      return { ok: true, value: field.type === "date" ? text.slice(0, 10) : date.toISOString() };
    }
    case "url": {
      const link = safeLink(text);
      return link ? { ok: true, value: link } : { ok: false, problem: "isn't an http(s) address" };
    }
    case "email":
      return text !== null && EMAIL.test(text) ? { ok: true, value: text.toLowerCase() } : { ok: false, problem: "isn't an email address" };
    case "yesno":
      if (typeof value === "boolean") return { ok: true, value };
      if (text !== null && /^(true|yes|1)$/i.test(text)) return { ok: true, value: true };
      if (text !== null && /^(false|no|0)$/i.test(text)) return { ok: true, value: false };
      return { ok: false, problem: "isn't yes or no" };
    case "enum":
      return text !== null && field.values?.includes(text)
        ? { ok: true, value: text }
        : { ok: false, problem: `isn't one of ${field.values?.join(", ")}` };
    case "list":
      return Array.isArray(value) ? { ok: true, value: value.slice(0, 200) } : { ok: false, problem: "isn't a list" };
  }
}

const LINES = /\r?\n/;

/**
 * What I typed on a form (M32), checked: only `allowed` fields, each as its kind; null or "" clears one, a required
 * one can't be cleared. Problems are said per field, and then nothing is saved.
 */
export function checkFormValues(
  type: DataType,
  allowed: readonly string[],
  values: Record<string, unknown>,
): { values: Record<string, unknown>; problems: { field: string; message: string }[] } {
  const checked: Record<string, unknown> = {};
  const problems: { field: string; message: string }[] = [];
  for (const [name, raw] of Object.entries(values)) {
    const field = allowed.includes(name) ? type.fields[name] : undefined;
    if (!field) {
      problems.push({ field: name, message: "isn't on this form" });
      continue;
    }
    if (raw === null || raw === undefined || raw === "") {
      if (field.required) problems.push({ field: name, message: "is required" });
      else checked[name] = null;
      continue;
    }
    const value = fieldValue(field, field.type === "list" && typeof raw === "string" ? raw.split(LINES).map((v) => v.trim()).filter(Boolean) : raw);
    if (value.ok) checked[name] = value.value;
    else problems.push({ field: name, message: value.problem });
  }
  return { values: checked, problems };
}

export interface CheckedEntity {
  /** The item with its fields as their kinds; fields the type doesn't name kept as they came (raw, M34-T4). */
  value: Record<string, unknown>;
  key: string | null;
  /** "salary isn't a number": the field is left out. */
  problems: string[];
  /** A required field (or the key) is missing or wrong: the entity isn't saved. */
  rejected: boolean;
}

/** An item a pipeline wrote, checked against its type. Fields of mine are never taken from it. */
export function checkEntity(type: DataType, item: Record<string, unknown>): CheckedEntity {
  const value = structuredClone(item);
  const problems: string[] = [];
  let rejected = false;
  for (const [name, field] of Object.entries(type.fields)) {
    if (field.mine) {
      if (entityValueAt(value, name) !== undefined) problems.push(`${name} is mine: a pipeline can't set it`);
      deleteAt(value, name);
      continue;
    }
    const raw = entityValueAt(value, name);
    if (raw === undefined || raw === null || raw === "") {
      deleteAt(value, name);
      if (field.required || name === type.key) {
        problems.push(`${name} is missing`);
        rejected = true;
      }
      continue;
    }
    const checked = fieldValue(field, raw);
    if (checked.ok) {
      setAt(value, name, checked.value);
    } else {
      deleteAt(value, name);
      problems.push(`${name} ${checked.problem}`);
      if (field.required || name === type.key) rejected = true;
    }
  }
  const keyValue = entityValueAt(value, type.key);
  const key = typeof keyValue === "string" ? keyValue : typeof keyValue === "number" ? String(keyValue) : null;
  return { value, key: rejected ? null : key, problems, rejected: rejected || key === null };
}

/** An entity as pipelines and pages see it: what pipelines wrote, with my fields over it. */
export function entityItem(value: unknown, mine: unknown, stage?: { field: string; value: string | null }): Record<string, unknown> {
  const item = structuredClone((value ?? {}) as Record<string, unknown>);
  if (stage) item[stage.field] = stage.value;
  for (const [name, field] of Object.entries((mine ?? {}) as Record<string, unknown>)) {
    const segments = name.split(".");
    let current: Record<string, unknown> = item;
    for (const segment of segments.slice(0, -1)) {
      if (!current[segment] || typeof current[segment] !== "object") current[segment] = {};
      current = current[segment] as Record<string, unknown>;
    }
    current[segments.at(-1)!] = field;
  }
  return item;
}

// --- the api (M30) ---

export interface AppSummaryView {
  appId: string;
  name: string;
  icon: (typeof VIEW_ICONS)[number];
  version: number | null;
  types: { name: string; entities: number }[];
  pipelines: { pipelineId: string; name: string; enabled: boolean }[];
}

export interface AppVersionSummaryView {
  version: number;
  changeSummary: string | null;
  dateCreated: string;
}

/** Data a hand-built page keeps that this App can take (M33): "Move my bills here". */
export interface AppImportView {
  from: ImportSource;
  label: string;
  /** from: collection: which one. */
  collection?: string;
  /** How many there are to move (moved ones are skipped). */
  count: number;
}

export const IMPORT_SOURCES = ["bills", "prices", "jobs", "collection"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

/** `collection` (M33-T5): a collection a pipeline's data.save kept (M13, a page's `view:`), into one of the App's types. */
export const AppImportRequestSchema = z
  .object({
    from: z.enum(IMPORT_SOURCES),
    collection: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/).optional(),
    type: z.string().regex(TYPE_NAME).optional(),
  })
  .strict()
  .refine((r) => r.from !== "collection" || (r.collection && r.type), "a collection's move names the collection and the type");
export type AppImportRequest = z.infer<typeof AppImportRequestSchema>;

export interface AppImportResult {
  moved: number;
  skipped: number;
}

/** M39-T2: the pipelines an App version's buttons run (`run:` of its pages' actions), by id, resolved when it was saved. */
export interface AppRefs {
  pipelines: Record<string, string>;
}

export interface AppDetailView extends AppSummaryView {
  definition: AppDefinition;
  imports: AppImportView[];
  /** The definition as YAML, for the editor. */
  source: string;
  versions: AppVersionSummaryView[];
}

export const SaveAppRequestSchema = z.object({ source: z.string().min(1).max(200_000) }).strict();
export type SaveAppRequest = z.infer<typeof SaveAppRequestSchema>;

export interface AppIssue {
  path: string;
  message: string;
  /** M35: its line in the App's YAML, when it is in it. */
  line?: number;
}

/** A save that would break one of its pipelines: refused, naming each one and why. */
export interface AppSaveRefusal {
  message: string;
  errors: AppIssue[];
  pipelines?: { pipelineId: string; name: string; errors: AppIssue[] }[];
}

export interface EntityView {
  key: string;
  value: Record<string, unknown>;
  mine: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
  removedAt: string | null;
}

export const EntityQuerySchema = z
  .object({
    removed: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();
export type EntityQuery = z.output<typeof EntityQuerySchema>;

export interface EntityListView {
  app: string;
  type: string;
  dataType: DataType;
  entities: EntityView[];
  total: number;
}

/**
 * M34-T4: fields the entities of a type have (from their sources) that the type doesn't name: a draft field each,
 * from the values seen, to add to the type.
 */
export interface AppDriftView {
  type: string;
  field: string;
  /** How many entities have it. */
  count: number;
  /** The kind its values have, as a draft type reads them. */
  suggested: EntityField;
  examples: string[];
}

export const AddFieldRequestSchema = z.object({ type: z.string().regex(TYPE_NAME), field: z.string().regex(ENTITY_FIELD) }).strict();
export type AddFieldRequest = z.infer<typeof AddFieldRequestSchema>;

/** M30-T7: a draft type from a run's step output. */
export const DraftTypeRequestSchema = z
  .object({ runId: z.uuid(), stepKey: z.string().min(1).max(100), field: z.string().min(1).max(100).optional() })
  .strict();
export type DraftTypeRequest = z.infer<typeof DraftTypeRequestSchema>;

export interface DraftTypeView {
  /** The draft as YAML, to put under `types:`. */
  source: string;
  type: DataType;
  /** How many items it was drafted from. */
  samples: number;
  /** M35-T4: a few of each field's values, as they came. */
  examples?: Record<string, string[]>;
}

/**
 * M35-T4: a type drafted from a sample I paste: a list of items, an object holding one (an API's `{ results: [...] }`),
 * or a single item.
 */
export const DraftTypeSampleRequestSchema = z.object({ sample: z.unknown() }).strict();
export type DraftTypeSampleRequest = z.infer<typeof DraftTypeSampleRequestSchema>;

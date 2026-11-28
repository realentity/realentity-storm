import { parse as parseYaml } from "yaml";
import { NeedsSchema } from "./needs";
import { z } from "zod";
import { HOST_PATTERN } from "./credentials";
import { CONDITION_OPS } from "./conditions";
import { holdsSealed, isSealed } from "./sealed";
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

export const FIELD_KINDS = [
  "text",
  "longtext",
  "number",
  "money",
  "date",
  "datetime",
  "url",
  "email",
  "yesno",
  "enum",
  "list",
  "file",
  "image",
  "ref",
  "credential",
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/** M46: kinds whose value is a stored file, uploaded on the form; the entity holds only its reference. */
export const FILE_KINDS: readonly FieldKind[] = ["file", "image"];

/** A stored file as an entity holds it (M46): never its bytes. */
export interface FileRef {
  id: string;
  name: string;
  mime: string;
  size: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A file's reference, or null: what a form sends (its id) and what an entity keeps ({ id, … }). */
export function fileRefId(value: unknown): string | null {
  const id = typeof value === "string" ? value : value && typeof value === "object" ? (value as { id?: unknown }).id : null;
  return typeof id === "string" && UUID.test(id) ? id.toLowerCase() : null;
}

/** The reference an entity keeps, when the value is one. */
export function asFileRef(value: unknown): FileRef | null {
  if (!value || typeof value !== "object") return null;
  const { id, name, mime, size } = value as Record<string, unknown>;
  return fileRefId(id) && typeof name === "string" && typeof mime === "string" && typeof size === "number" ? { id: id as string, name, mime, size } : null;
}

/** Kinds a key can be: one that names the entity as text. */
const KEY_KINDS: readonly FieldKind[] = ["text", "url", "email", "number"];

/** Field values an entity must have: one, or one of a list (a button's `when`, a total's, a due date's `unless`). */
const Conditions = z.record(z.string().regex(ENTITY_FIELD), z.union([z.string().max(60), z.boolean(), z.array(z.string().max(60)).min(1)]));

/** M56: kinds a field's `when` looks at: the form shows the field while they have its values. */
const WHEN_KINDS: readonly FieldKind[] = ["enum", "yesno"];

export const EntityFieldSchema = z
  .object({
    type: z.enum(FIELD_KINDS),
    label: z.string().trim().min(1).max(40).optional(),
    required: z.boolean().default(false),
    /** Set by the user (M32's forms); a pipeline never writes it. */
    mine: z.boolean().default(false),
    /** enum: the values it may take. */
    values: z.array(z.string().trim().min(1).max(60)).min(1).max(50).optional(),
    /** money: the field holding the currency code. */
    currency: z.string().regex(ENTITY_FIELD).optional(),
    /** M55: ref: the type of this App it points at; the field holds that entity's key. */
    to: z.string().regex(TYPE_NAME).optional(),
    /**
     * M56: a list of refs (`to` says of what), in the order they are picked: { type: list, of: ref, to: Path }.
     * M65: a list of text (tags): { type: list, of: text }, each value trimmed, empty ones dropped.
     */
    of: z.enum(["ref", "text"]).optional(),
    /** M65: a list of text: each value once, the first spelling kept (default true). */
    unique: z.boolean().optional(),
    /** M65: a list of text: "Home" and "home" differ, when saved, filtered and searched (default false). */
    caseSensitive: z.boolean().optional(),
    /**
     * M56: a ref (or a list of refs) picked only among the ones whose field of this name is this entity's: an Entry's
     * path among its project's paths (match: project). Both are refs to the same type.
     */
    match: z.string().regex(ENTITY_FIELD).optional(),
    /**
     * M57: credential: the host it is for (api.github.com). The field holds one of the user's credentials, by id, picked
     * on the form among the ones allowed there; a pipeline gets it as a handle, opened only as http.fetch or
     * http.request sends it to a host the credential allows.
     */
    for: z.string().regex(HOST_PATTERN, "a host, e.g. api.github.com").optional(),
    /** M56: on the form only while other fields have these values (enum or yes/no ones); required only then. */
    when: Conditions.optional(),
    /** M55: a line under its input on the form: what to write there (M57: up to 1000: a token's permissions). */
    help: z.string().trim().min(1).max(1000).optional(),
    /**
     * M48: the key, made by Storm when an entity is added (on its list, or by a pipeline's item without it): a task or a
     * memo is named by its title, which can change. Only on a text key.
     */
    auto: z.boolean().optional(),
    /**
     * M52: a secret the App keeps (a token, a password to send elsewhere). Sealed in the database like a credential
     * (docs/design.md §7), never shown on a form, page or list; a pipeline holds it as a handle that prints `***`, opened
     * only by the worker as an `http.request` sends it. Only on a text or longtext field that names nothing.
     */
    encrypted: z.boolean().optional(),
  })
  .strict();
export type EntityField = z.output<typeof EntityFieldSchema>;

/** M56: a ref, or a list of refs: it points at entities of its type `to`. */
export function isRefField(field: Pick<EntityField, "type" | "of">): boolean {
  return field.type === "ref" || (field.type === "list" && field.of === "ref");
}

/** M65: a list of text (tags). */
export function isTextList(field: Pick<EntityField, "type" | "of">): boolean {
  return field.type === "list" && field.of === "text";
}

/** M65: the fields of a type whose list values match without case: its lists of text that aren't `caseSensitive`. */
export function caselessFields(type: Pick<DataType, "fields">): Set<string> {
  return new Set(
    Object.entries(type.fields)
      .filter(([, field]) => isTextList(field) && field.caseSensitive !== true)
      .map(([name]) => name),
  );
}

/** M65: the longest value of a list of text, and how many values it keeps. */
const TEXT_LIST_ITEM_MAX = 200;
const LIST_MAX = 200;

/**
 * M65: a list of text as saved: values trimmed, empty ones dropped, each once (the first spelling kept; without case
 * unless `caseSensitive`), unless `unique: false`. One value given as text is a one-item list (a field that was one
 * value before, like Tasks' `tag`).
 */
export function cleanTextList(field: Pick<EntityField, "unique" | "caseSensitive">, value: unknown): string[] | null {
  const values: unknown[] | null = typeof value === "string" ? [value] : null;
  const entries = values ?? (Array.isArray(value) ? value : null);
  if (entries === null) return null;
  const texts: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const text = textEntry(entry);
    if (text === null) return null;
    if (text === "") continue;
    const id = field.caseSensitive === true ? text : text.toLowerCase();
    if (field.unique !== false && seen.has(id)) continue;
    seen.add(id);
    texts.push(text);
  }
  return texts.slice(0, LIST_MAX);
}

/** A value of a list of text, trimmed; null: not text. */
function textEntry(entry: unknown): string | null {
  if (typeof entry === "string") return entry.trim().slice(0, TEXT_LIST_ITEM_MAX);
  return typeof entry === "number" && Number.isFinite(entry) ? String(entry) : null;
}

/**
 * M65: an entity's lists of text as lists, also when saved as one value before the field became a list (Tasks'
 * `tag`, once an enum). Changes the item in place; other fields as they are.
 */
export function withTextLists<T extends Record<string, unknown>>(type: Pick<DataType, "fields">, item: T): T {
  for (const [name, field] of Object.entries(type.fields)) {
    if (!isTextList(field)) continue;
    const value = entityValueAt(item, name);
    if (typeof value === "string") setAt(item, name, value.trim() === "" ? [] : [value.trim()]);
  }
  return item;
}

/** M56: does an entity (or a form's values) have what a field's `when` asks for? A field without one always applies. */
export function fieldApplies(field: Pick<EntityField, "when">, values: Record<string, unknown>): boolean {
  return Object.entries(field.when ?? {}).every(([name, wanted]) => {
    const value = entityValueAt(values, name);
    const text = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
    return Array.isArray(wanted) ? wanted.includes(text) : text === String(wanted);
  });
}

/** M56: a field's `of`, `match` and `when`, against the other fields of its type. */
function checkFieldOptions(
  fields: Record<string, EntityField>,
  name: string,
  field: EntityField,
  key: string,
  issue: (path: string[], message: string) => void,
): void {
  if (field.of && field.type !== "list")
    issue(["of"], field.of === "ref" ? "only a list holds refs: type: list, of: ref" : "only a list holds text values: type: list, of: text");
  for (const option of ["unique", "caseSensitive"] as const) {
    if (field[option] !== undefined && !isTextList(field)) issue([option], `only a list of text has ${option}: type: list, of: text`);
  }
  if (field.match !== undefined) {
    const other = fields[field.match];
    if (!isRefField(field)) issue(["match"], "only a ref picks among the ones that match");
    else if (field.match === name) issue(["match"], "a ref matches another field of its type");
    else if (other?.type !== "ref") issue(["match"], `"${field.match}" isn't a ref field of this type`);
  }
  if (!field.when) return;
  if (name === key) issue(["when"], "the key is always on the form");
  for (const [other, wanted] of Object.entries(field.when)) {
    const by = fields[other];
    if (!by || other === name) issue(["when", other], `"${other}" isn't another field of this type`);
    else if (!WHEN_KINDS.includes(by.type)) issue(["when", other], `a field shows by an enum or a yes/no field: "${other}" is ${by.type}`);
    else if (by.type === "enum") {
      for (const value of Array.isArray(wanted) ? wanted : [wanted]) {
        if (!by.values?.includes(String(value)))
          issue(["when", other], `"${String(value)}" isn't one of ${other}'s values (${by.values?.join(", ")})`);
      }
    }
  }
}

/** M57: the type's credential fields, by name. */
export function credentialFields(type: Pick<DataType, "fields">): string[] {
  return Object.entries(type.fields)
    .filter(([, field]) => field.type === "credential")
    .map(([name]) => name);
}

/** M52: kinds a field may be encrypted on. */
export const ENCRYPTABLE_KINDS: readonly FieldKind[] = ["text", "longtext"];

/** M52: the type's encrypted fields, by name. */
export function encryptedFields(type: Pick<DataType, "fields">): string[] {
  return Object.entries(type.fields)
    .filter(([, field]) => field.encrypted === true)
    .map(([name]) => name);
}

/** M48: a key Storm makes (an `auto` key): 12 lowercase letters and digits. */
export function newKey(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** M48: the type's key is made by Storm. */
export function autoKey(type: Pick<DataType, "key" | "fields">): boolean {
  return type.fields[type.key]?.auto === true;
}

export const STAGE_ACTORS = ["me", "pipeline"] as const;
export type StageActor = (typeof STAGE_ACTORS)[number];
const STATE = z.string().trim().min(1).max(40);

/**
 * An entity's stage (M32): where it is (new, applied, interview…), moved only as `moves` allow and by whom:
 * the user (`me`) on its page, or a pipeline's data.save. The date it first reached each state is kept.
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
            /** Default: only the user (`me`), on its page. */
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
    /** A type the user writes (M32), on its pages' forms: things to watch, people. Pipelines only read it. */
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
    else if (key.auto && key.type !== "text") issue(["fields", type.key, "auto"], "a key Storm makes is text");
    if (type.title && !type.fields[type.title]) issue(["title"], `"${type.title}" is not one of the fields`);
    for (const [name, field] of Object.entries(type.fields)) {
      const at = ["fields", name];
      if (names.some((other) => other.startsWith(`${name}.`))) issue(at, `"${name}" can't be a field and hold fields too`);
      if (field.type === "enum" && !field.values) issue([...at, "values"], "an enum needs its values");
      if (isRefField(field) && !field.to) issue([...at, "to"], "a ref says which type it points at: to: Project");
      if (!isRefField(field) && field.to) issue([...at, "to"], "only a ref (or a list of: ref) points at a type");
      checkFieldOptions(type.fields, name, field, type.key, (path, message) => issue([...at, ...path], message));
      if (field.type !== "enum" && field.values) issue([...at, "values"], "only an enum has values");
      if (field.type === "credential") {
        if (!field.for) issue([...at, "for"], "a credential says the host it is for: for: api.github.com");
        if (!type.mine) issue(at, "a credential is only on a type of mine: pipelines never write which one it is");
        if (name === type.key || name === type.title) issue(at, "a credential doesn't name the entity");
        if (field.encrypted) issue([...at, "encrypted"], "a credential is kept as one already");
      } else if (field.for) issue([...at, "for"], "only a credential is for a host");
      if (field.auto && name !== type.key) issue([...at, "auto"], "only the key is made by Storm");
      if (field.encrypted) {
        if (name.includes(".")) issue([...at, "encrypted"], "an encrypted field isn't nested: write it as one name");
        if (!ENCRYPTABLE_KINDS.includes(field.type))
          issue([...at, "encrypted"], `only text and longtext can be encrypted, not ${field.type}`);
        if (name === type.key) issue([...at, "encrypted"], "the key names the entity, so it can't be encrypted");
        if (name === type.title) issue([...at, "encrypted"], "the title is shown, so it can't be encrypted");
        if (Object.values(type.fields).some((other) => other.currency === name))
          issue([...at, "encrypted"], "a currency is shown, so it can't be encrypted");
      }
      if (field.currency !== undefined) {
        if (field.type !== "money") issue([...at, "currency"], "only money has a currency");
        else if (type.fields[field.currency]?.type !== "text")
          issue([...at, "currency"], `"${field.currency}" is not a text field of this type`);
      }
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

/** What Storm knows of every entity besides its fields: a list may show, sort and group by them. */
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

/**
 * An entity's button (M32): starts a pipeline triggered by { on: entity.action } with the entity. `when`: only while
 * its fields have these values (one, or one of a list), e.g. { status: favorite }.
 */
const EntityAction = PageAction.extend({
  when: Conditions.optional(),
}).strict();
export type EntityActionDef = z.output<typeof EntityAction>;

const PageSort = z.string().regex(/^-?(@firstSeen|@lastSeen|[A-Za-z_][\w.-]*)$/, '"field" or "-field", e.g. -salary');

/** M65: a source's name on its page, by which a control uses it ("tags", "days"). */
export const SOURCE_NAME = /^[a-z][A-Za-z0-9]{0,39}$/;

/**
 * M65: a page's query of the App's own data (DataSource): the distinct values of a field with how many have each (the
 * tags in use; a date's days with `by: day`), or entities of a type (`where`, `sort`), each with an id and a label.
 * Always a collection; how many may be picked is the control's. Evaluated by the api, over the App's own types and (M66) its uses.
 */
export const PageSourceSchema = z.union([
  z
    .object({
      from: z.string().regex(TYPE_NAME),
      distinct: PageField,
      /** A date's or a time's day, in the instance's time zone (TZ). */
      by: z.literal("day").optional(),
    })
    .strict(),
  z
    .object({
      from: z.string().regex(TYPE_NAME),
      /** data.read's conditions. */
      where: z
        .array(z.object({ field: PageField, op: z.enum(CONDITION_OPS), value: z.unknown() }).strict())
        .max(10)
        .optional(),
      sort: PageSort.optional(),
      /** The field that is an item's id; default its key. */
      id: PageField.optional(),
      /** The field it is shown by; default its title (else its key). */
      display: PageField.optional(),
      limit: z.number().int().min(1).max(500).default(200),
    })
    .strict(),
]);
export type PageSource = z.output<typeof PageSourceSchema>;

/**
 * M65: controls, how a field is drawn, built into Storm (never an App's own React). A column reads a value: as text,
 * or a list's or an enum's as chips. A filter control picks what narrows the list: a dropdown, buttons or chips of
 * values; a date input or a calendar (a month with its days marked) of days.
 */
export const READ_CONTROLS = ["text", "chips"] as const;
export type ReadControl = (typeof READ_CONTROLS)[number];
export const FILTER_CONTROLS = ["dropdown", "buttons", "chips", "calendar", "date"] as const;
export type FilterControl = (typeof FILTER_CONTROLS)[number];

/** M65: the filter controls of a kind, its default first: a date's days, anything else's values. */
export function filterControlsOf(kind: FieldKind | undefined): readonly FilterControl[] {
  return kind === "date" || kind === "datetime" ? ["date", "calendar"] : ["dropdown", "buttons", "chips"];
}

/**
 * M65: a filter drawn by a control, its choices from one of the page's sources (default: the filter's own values),
 * e.g. { control: buttons, source: tags, filters: tags }; `multiple`: several picked, any of them matching.
 */
const PageControlSchema = z
  .object({
    control: z.enum(FILTER_CONTROLS),
    filters: PageField,
    source: z.string().regex(SOURCE_NAME, 'a source of the page, e.g. "tags"').optional(),
    multiple: z.boolean().default(false),
    label: z.string().trim().min(1).max(40).optional(),
  })
  .strict();
export type PageControl = z.output<typeof PageControlSchema>;

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
              /** M65: how the value is shown: text (default), or a list's or an enum's values as chips. */
              control: z.enum(READ_CONTROLS).optional(),
              /** A date field (M33): a badge when it is past, today or within `days`, unless the entity is as `unless` says. */
              due: z.object({ days: z.number().int().min(0).max(60).default(3), unless: Conditions.optional() }).strict().optional(),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(8)
      .optional(),
    /**
     * Fields to filter by: enum and yes/no ones, picked from their values; M65: a list's values (a tag), a date's day
     * or range (@firstSeen too).
     */
    filters: z.array(PageField).max(6).optional(),
    /** M65: named queries of the App's own data, for the page's controls: { tags: { from: Memo, distinct: tags } }. */
    sources: z
      .record(z.string().regex(SOURCE_NAME, 'a name, e.g. "tags"'), PageSourceSchema)
      .refine((sources) => Object.keys(sources).length <= 6, "6 sources at most")
      .optional(),
    /** M65: filters drawn by a control, besides `filters` (each a dropdown or a date input). */
    controls: z.array(PageControlSchema).max(6).optional(),
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
     * M45: entities added (New on the list: the key and the form's fields) and deleted by hand, on a type pipelines
     * write too. What I set stays over what they write. A type of mine is always added by hand.
     */
    add: z.boolean().default(false),
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
    /**
     * M55: the entities pointing at this one (a ref field of theirs, `by`), listed on its page; `add`: one added there,
     * `by` set to this one.
     */
    related: z
      .array(
        z
          .object({
            type: z.string().regex(TYPE_NAME),
            by: z.string().regex(ENTITY_FIELD),
            label: z.string().trim().min(1).max(40).optional(),
            columns: z.array(z.string().regex(ENTITY_FIELD)).min(1).max(8).optional(),
            filters: z.array(z.string().regex(ENTITY_FIELD)).max(4).optional(),
            /**
             * true: an Add button; M56: or a button each, its form with fields set: { label: Add secret, set: { kind:
             * secret } }. An add takes the list's filters and group too.
             */
            add: z
              .union([
                z.boolean(),
                z
                  .array(
                    z
                      .object({
                        label: z.string().trim().min(1).max(30),
                        set: z.record(z.string().regex(ENTITY_FIELD), z.union([z.string().max(60), z.boolean()])).default({}),
                      })
                      .strict(),
                  )
                  .min(1)
                  .max(4),
              ])
              .default(false),
            /**
             * M56: rows in groups by an enum or a ref field, a group for each of its values (a ref's: the entities of its
             * type, the ones matching this entity when it matches by `by`), empty ones too: each with its own Add.
             */
            group: z.string().regex(ENTITY_FIELD).optional(),
          })
          .strict(),
      )
      .max(4)
      .optional(),
  })
  .strict();
export type ViewPage = z.output<typeof ViewPageSchema>;

/**
 * The form on an entity's page (M32): which fields, in what order; default the fields of mine. M45: any field but the
 * key and the stage; what I set there stays over what pipelines write, until I reset it.
 */
export const FormPageSchema = z
  .object({
    form: z.string().regex(TYPE_NAME),
    fields: z.array(z.string().regex(ENTITY_FIELD)).min(1).max(40).optional(),
  })
  .strict();
export type FormPage = z.output<typeof FormPageSchema>;

/**
 * What a report counts: `count: true` (the entities), `sum: <field>` (number or money), or `reached: <state>` (or any of
 * a list of states); of the ones `when` says.
 */
const ReportState = z.string().trim().min(1).max(40);
const ReportMeasure = {
  label: z.string().trim().min(1).max(30),
  count: z.literal(true).optional(),
  sum: z.string().regex(ENTITY_FIELD).optional(),
  reached: z.union([ReportState, z.array(ReportState).min(1).max(10)]).optional(),
  when: Conditions.optional(),
};

/**
 * A type's report: tiles of counts and sums over a period, trends over time and tables by a field, of the entities whose
 * `date` falls in the period. A tile's `of` shows it as a share of another tile; a table's columns are tiles, by group.
 */
export const ReportPageSchema = z
  .object({
    report: z.string().regex(TYPE_NAME),
    /** In the menu, after the App's lists. Default: "<type> report". */
    menu: PageMenu.optional(),
    /** What puts an entity in a period: a date field, or when it was first or last seen. */
    date: PageField.default("@firstSeen"),
    /** The periods to pick from, in days; the first is shown first. All time is always offered. */
    periods: z.array(z.number().int().min(1).max(3650)).min(1).max(6).default([30, 90, 365]),
    tiles: z
      .array(z.object({ ...ReportMeasure, of: z.string().trim().min(1).max(30).optional() }).strict())
      .min(1)
      .max(8),
    /** A line over the period, a point per day, week or month. */
    trends: z
      .array(z.object({ ...ReportMeasure, every: z.enum(["day", "week", "month"]).default("week") }).strict())
      .max(4)
      .default([]),
    /** The tiles again, a row per value of a field (or per band of a number). */
    tables: z
      .array(
        z
          .object({
            by: z.string().regex(ENTITY_FIELD),
            label: z.string().trim().min(1).max(40).optional(),
            /** A number field in bands, from their lower bounds: [80, 60, 40, 0]. */
            bands: z.array(z.number()).min(1).max(8).optional(),
            columns: z.array(z.string().trim().min(1).max(30)).min(1).max(6),
          })
          .strict(),
      )
      .max(4)
      .default([]),
  })
  .strict();
export type ReportPage = z.output<typeof ReportPageSchema>;

export const AppPageSchema = z.union([ListPageSchema, ViewPageSchema, FormPageSchema, ReportPageSchema]);
export type AppPage = z.output<typeof AppPageSchema>;

/**
 * M66: another App's type this App reads, under a local name (`uses: { Bill: { from: { app: Bills, type: Bill },
 * fields: [...] } }`). `from` is as written in the file; which of the user's Apps fills it is chosen at install and
 * kept by id (an AppUse). Only the named fields are read, with the key, the title and the stage; never encrypted,
 * credential or file fields. Reads only: a change goes through the owner App's pipelines.
 */
export const AppUseSchema = z
  .object({
    from: z
      .object({
        app: z.string().trim().regex(APP_NAME, "an App's name"),
        type: z.string().regex(TYPE_NAME, 'a type name, e.g. "Bill"'),
      })
      .strict(),
    fields: z
      .array(z.string().regex(ENTITY_FIELD, 'a field name, e.g. "amount"'))
      .min(1, "at least one field")
      .max(60)
      .refine((fields) => new Set(fields).size === fields.length, "a field is named once"),
    /** Why it is used, shown where the user chooses which App fills it. */
    help: z.string().trim().min(1).max(500).optional(),
    /**
     * The App works without it (Papers without a Bills App): not chosen, data.read gives no items and the checklist
     * doesn't wait for it. Chosen and no longer fitting still stops, as a mistake to fix.
     */
    optional: z.boolean().optional(),
    /**
     * M66-T6: its fields that are mine there (a Person's email you typed in Contacts), so they may be targets here, as a
     * type of mine's are: a recipient, an address. Only a type where each is a field of mine fits.
     */
    mine: z.array(z.string().regex(ENTITY_FIELD, 'a field name, e.g. "email"')).min(1).max(20).optional(),
  })
  .strict()
  .superRefine((use, ctx) => {
    use.mine?.forEach((field, i) => {
      if (!use.fields.includes(field)) ctx.addIssue({ code: "custom", path: ["mine", i], message: `"${field}" isn't one of its fields (${use.fields.join(", ")})` });
    });
  });
export type AppUse = z.output<typeof AppUseSchema>;

/** M66: the field kinds a use can't read: what is sealed or kept as a file stays in its App. */
const UNUSABLE_KINDS: readonly FieldKind[] = ["credential", "file", "image"];

/**
 * M66: what keeps another App's type from filling a use: a declared field it lacks, or one that can't be read from
 * another App (encrypted, a credential, a file or an image). Empty: it fits. `identified` (a ref points at the use,
 * or a page lists its entities, see `identifiedUses`): its key and title must be among the fields too, since a ref
 * holds the key and shows the title.
 */
export function useProblems(use: Pick<AppUse, "fields" | "mine">, type: DataType, identified = false): string[] {
  const problems: string[] = [];
  for (const name of use.fields) {
    const field = Object.hasOwn(type.fields, name) ? type.fields[name] : undefined;
    if (!field) problems.push(`it has no field "${name}"`);
    else if (field.encrypted) problems.push(`${name} is encrypted`);
    else if (UNUSABLE_KINDS.includes(field.type)) problems.push(`${name} is a ${field.type}`);
    // M66-T6: one it targets is one I typed there.
    else if (use.mine?.includes(name) && !type.mine && !field.mine) problems.push(`${name} isn't a field of mine there (typed by me)`);
  }
  if (identified) {
    if (!use.fields.includes(type.key)) problems.push(`its key ${type.key} isn't among the fields read (a ref holds it)`);
    const title = type.title ?? type.key;
    if (title !== type.key && !use.fields.includes(title)) problems.push(`its title ${title} isn't among the fields read (a ref shows it)`);
  }
  return problems;
}

/**
 * M66: the uses an App points at by a ref, or whose entities a page lists without naming their id and label: the
 * ones whose chosen type's key and title must be among the fields read.
 */
export function identifiedUses(app: { types: Record<string, DataType>; pages: AppPage[]; uses?: Record<string, AppUse> }): Set<string> {
  const uses = app.uses ?? {};
  const named = new Set<string>();
  for (const type of Object.values(app.types))
    for (const field of Object.values(type.fields)) if (isRefField(field) && field.to && Object.hasOwn(uses, field.to)) named.add(field.to);
  for (const page of app.pages) {
    if (!("list" in page)) continue;
    for (const source of Object.values(page.sources ?? {}))
      if (Object.hasOwn(uses, source.from) && !("distinct" in source) && (!source.id || !source.display)) named.add(source.from);
  }
  return named;
}

/** M66: the chosen type as a use reads it: only the declared fields, its stages only when their field is one. */
export function narrowedType(type: DataType, use: Pick<AppUse, "fields">): DataType {
  return {
    ...type,
    fields: Object.fromEntries(use.fields.filter((f) => Object.hasOwn(type.fields, f)).map((f) => [f, type.fields[f]])),
    stages: type.stages && use.fields.includes(type.stages.field) ? type.stages : undefined,
  };
}

/** M66: only a use's declared fields of an entity, at their paths. */
export function declaredOnly(item: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of fields) {
    const value = entityValueAt(item, path);
    if (value === undefined) continue;
    const segments = path.split(".");
    let current = out;
    for (const segment of segments.slice(0, -1)) {
      if (!current[segment] || typeof current[segment] !== "object") current[segment] = {};
      current = current[segment] as Record<string, unknown>;
    }
    current[segments.at(-1)!] = value;
  }
  return out;
}

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
    /** M50: credentials and settings its pipelines share, by slot; each install of the App fills its own. */
    needs: NeedsSchema.optional(),
    /** M66: other Apps' types it reads, by a local name; each install chooses which App fills each. */
    uses: z
      .record(z.string().regex(TYPE_NAME, 'a name, e.g. "Bill": a capital letter, then letters and digits'), AppUseSchema)
      .refine((uses) => Object.keys(uses).length <= 10, "at most 10")
      .optional(),
  })
  .strict()
  .superRefine((app, ctx) => {
    const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    // M66: a use's name is how the App's pipelines and pages call it: never one of its own types.
    for (const name of Object.keys(app.uses ?? {})) {
      if (Object.hasOwn(app.types, name)) issue(["uses", name], `"${name}" is a type of this App: give the use another name (e.g. ${app.uses![name].from.app.replace(/[^A-Za-z0-9]/g, "")}${name})`);
    }
    checkPages(app, issue);
  });
export type AppDefinition = z.output<typeof AppDefinitionSchema>;

const FILTER_KINDS: readonly FieldKind[] = ["enum", "yesno", "ref"];
// M56: a ref is searched by what it points at's title.
const SEARCH_KINDS: readonly FieldKind[] = ["text", "longtext", "email", "url", "enum", "ref", "list"];
const TOTAL_KINDS: readonly FieldKind[] = ["number", "money"];
const PERIOD_KINDS: readonly FieldKind[] = ["date", "datetime"];
/** M65: a list page also filters by a list's values and a date's day or range. */
export const LIST_FILTER_KINDS: readonly FieldKind[] = [...FILTER_KINDS, "list", "date", "datetime"];
/** M65: what a column shows as chips. */
export const CHIP_KINDS: readonly FieldKind[] = ["list", "enum"];
/** M65: what a source counts the distinct values of. */
export const DISTINCT_KINDS: readonly FieldKind[] = ["text", "email", "number", "enum", "yesno", "list", "ref", "date", "datetime"];

/** Pages only on the App's types, and only on their fields, each used as its kind allows. */
function checkPages(
  app: { types: Record<string, DataType>; pages: AppPage[]; uses?: Record<string, AppUse> },
  issue: (path: (string | number)[], message: string) => void,
): void {
  // M55: a ref points at a type of this App; M66: or at a use, another App's type it reads.
  const uses = Object.keys(app.uses ?? {});
  for (const [typeName, type] of Object.entries(app.types)) {
    for (const [name, field] of Object.entries(type.fields)) {
      if (!isRefField(field) || !field.to) continue;
      if (uses.includes(field.to)) {
        if (field.match) issue(["types", typeName, "fields", name, "match"], `${field.to} is another App's type (a use): a ref to it can't match`);
        continue;
      }
      if (!Object.hasOwn(app.types, field.to)) {
        const or = uses.length > 0 ? `; uses: ${uses.join(", ")}` : "";
        issue(["types", typeName, "fields", name, "to"], `there is no type "${field.to}" (types: ${Object.keys(app.types).join(", ")}${or})`);
        continue;
      }
      // M56: a path of the entry's project: Path.project and Entry.project point at the same type.
      const by = field.match ? type.fields[field.match] : undefined;
      const theirs = field.match ? app.types[field.to].fields[field.match] : undefined;
      if (by?.type === "ref" && (theirs?.type !== "ref" || theirs.to !== by.to)) {
        issue(
          ["types", typeName, "fields", name, "match"],
          `${field.to}.${field.match} isn't a ref to ${by.to} as ${typeName}.${field.match} is`,
        );
      }
    }
  }
  // A field of mine required: only on a type added by hand (M47: a Monitor's address), where the form makes it;
  // pipelines write the others first, without it.
  for (const [typeName, type] of Object.entries(app.types)) {
    if (type.mine || addedByHand(app, typeName)) continue;
    for (const [name, field] of Object.entries(type.fields)) {
      if (field.mine && field.required) {
        issue(["types", typeName, "fields", name, "required"], "a field of mine can't be required unless its type is added by hand (add: true on its list): pipelines write the entity first");
      }
    }
  }
  const seen = new Set<string>();
  app.pages.forEach((page, i) => {
    const [kind, typeName] = pageKind(page);
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
    // M52: an encrypted field is never shown in a list nor used to find, sort or group one: only on its page and form.
    const shown = (name: string, path: (string | number)[], where: string) => {
      field(name, path);
      if (type.fields[name]?.encrypted) issue(path, `${typeName}.${name} is encrypted: it can't be ${where}`);
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
      for (const name of Object.keys(when ?? {})) shown(name, [...at, "actions", j, "when", name], "a button's condition");
    });
    if ("report" in page) return checkReport(page, type, typeName, at, field, shown, issue);
    if ("form" in page) {
      for (const [j, name] of (page.fields ?? []).entries()) {
        field(name, [...at, "fields", j]);
        if (name === type.stages?.field) issue([...at, "fields", j], `${typeName}.${name} is its stage: it moves by its buttons, not on the form`);
        else if (name === type.key && !type.mine) issue([...at, "fields", j], `${typeName}.${name} is its key: it names the entity and stays`);
      }
      return;
    }
    if ("list" in page) {
      if (page.add && !type.mine) {
        const form = app.pages.find((p): p is FormPage => "form" in p && p.form === typeName);
        const fields = addFieldNames(type, form);
        const missing = Object.entries(type.fields).filter(([name, f]) => f.required && !f.auto && name !== type.stages?.field && !fields.includes(name));
        for (const [name] of missing) issue([...at, "add"], `${typeName}.${name} is required: put it on ${typeName}'s form to add one by hand`);
      }
      page.columns?.forEach((c, j) => {
        if (typeof c === "string") return shown(c, [...at, "columns", j], "a column");
        field(c.field, [...at, "columns", j], c.due ? PERIOD_KINDS : undefined, "a due badge is on a date field");
        if (type.fields[c.field]?.encrypted) issue([...at, "columns", j], `${typeName}.${c.field} is encrypted: it can't be a column`);
        for (const name of Object.keys(c.due?.unless ?? {})) field(name, [...at, "columns", j, "due", "unless", name]);
        const kind = kindOf(c.field);
        if (c.control === "chips" && kind && !CHIP_KINDS.includes(kind)) issue([...at, "columns", j, "control"], `chips show a list's or an enum's values: "${c.field}" is ${kind}`);
      });
      checkControls(page, typeName, at, kindOf, issue);
      if (page.moves && !type.stages) issue([...at, "moves"], `${typeName} has no stages to move`);
      page.filters?.forEach((f, j) => field(f, [...at, "filters", j], LIST_FILTER_KINDS, "a filter is an enum, a yes/no, a ref, a list or a date field"));
      for (const [name, source] of Object.entries(page.sources ?? {})) checkSource(app, source, [...at, "sources", name], issue);
      page.search?.forEach((f, j) => {
        field(f, [...at, "search", j], SEARCH_KINDS, "search looks in text fields");
        // M65: a list of text (tags) too, as the default search does; not a list of anything else.
        const listed = type.fields[f];
        if (listed?.type === "list" && !isTextList(listed)) issue([...at, "search", j], `search looks in text fields: "${f}" is a list, not of text`);
        if (type.fields[f]?.encrypted) issue([...at, "search", j], `${typeName}.${f} is encrypted: it can't be searched`);
      });
      if (page.sort) shown(page.sort.replace(/^-/, ""), [...at, "sort"], "sorted by");
      if (page.group) {
        shown(page.group.by, [...at, "group", "by"], "grouped by");
        if (page.group.period) field(page.group.by, [...at, "group", "period"], PERIOD_KINDS, "a period groups a date field");
        page.group.totals.forEach((t, j) => {
          field(typeof t === "string" ? t : t.field, [...at, "group", "totals", j], TOTAL_KINDS, "a total is a number or money field");
          if (typeof t !== "string") for (const name of Object.keys(t.when ?? {})) field(name, [...at, "group", "totals", j, "when", name]);
        });
      }
    } else if ("view" in page) {
      // M55: what points at this type, by one of its ref fields; its columns and filters as a list's.
      page.related?.forEach((related, j) => {
        const where = [...at, "related", j];
        const other = Object.hasOwn(app.types, related.type) ? app.types[related.type] : undefined;
        if (!other) return issue([...where, "type"], `there is no type "${related.type}"`);
        const by = other.fields[related.by];
        if (by?.type !== "ref" || by.to !== typeName) issue([...where, "by"], `${related.type}.${related.by} isn't a ref to ${typeName}`);
        related.columns?.forEach((c, k) => {
          if (!other.fields[c]) issue([...where, "columns", k], `${related.type} has no field "${c}"`);
          else if (other.fields[c].encrypted) issue([...where, "columns", k], `${related.type}.${c} is encrypted: it can't be a column`);
        });
        related.filters?.forEach((f, k) => {
          const kind = other.fields[f]?.type;
          if (!kind) issue([...where, "filters", k], `${related.type} has no field "${f}"`);
          else if (!FILTER_KINDS.includes(kind))
            issue([...where, "filters", k], `a filter is an enum, a yes/no or a ref field: "${f}" is ${kind}`);
        });
        if (related.add && !addedByHand(app, related.type))
          issue([...where, "add"], `${related.type} isn't added by hand (a type of mine, or add: true on its list)`);
        if (Array.isArray(related.add)) {
          related.add.forEach((preset, k) => {
            for (const [name, value] of Object.entries(preset.set)) {
              const f = other.fields[name];
              const at2 = [...where, "add", k, "set", name];
              if (!f) issue(at2, `${related.type} has no field "${name}"`);
              else if (name === related.by) issue(at2, `${related.by} is set to this ${typeName} already`);
              else if (!fieldValue(f, value).ok)
                issue(at2, `${related.type}.${name} ${(fieldValue(f, value) as { problem: string }).problem}`);
            }
          });
        }
        if (related.group !== undefined) {
          const g = other.fields[related.group];
          if (!g) issue([...where, "group"], `${related.type} has no field "${related.group}"`);
          else if (g.type !== "enum" && g.type !== "ref")
            issue([...where, "group"], `a related list groups by an enum or a ref field: "${related.group}" is ${g.type}`);
          else if (related.group === related.by) issue([...where, "group"], `${related.by} is this ${typeName}: every row has it`);
          else if (g.type === "ref" && uses.some((u) => u === g.to))
            issue([...where, "group"], `${related.group} points at another App's type (${g.to}): a related list groups by a ref to this App's own types`);
        }
      });
      page.fields?.forEach((f, j) => field(f, [...at, "fields", j]));
      page.sections?.forEach((section, j) => section.fields.forEach((f, k) => field(f, [...at, "sections", j, "fields", k])));
      if (page.fields && page.sections) issue([...at, "sections"], "fields or sections, not both");
    }
  });
}

/** A page's kind and the type it is of. */
export function pageKind(page: AppPage): ["list" | "view" | "form" | "report", string] {
  if ("list" in page) return ["list", page.list];
  if ("view" in page) return ["view", page.view];
  if ("form" in page) return ["form", page.form];
  return ["report", page.report];
}

/**
 * M65: a list's filter controls: each on a field a filter may be, by a control of its kind, once per field (with
 * `filters` too); its source one of the page's, of days for a calendar and of values or items for the others.
 */
function checkControls(
  page: ListPage,
  typeName: string,
  at: (string | number)[],
  kindOf: (field: string) => FieldKind | undefined,
  issue: (path: (string | number)[], message: string) => void,
): void {
  const filtered = new Set(page.filters ?? []);
  page.controls?.forEach((c, j) => {
    const path = [...at, "controls", j];
    const kind = kindOf(c.filters);
    if (!kind) issue([...path, "filters"], `${typeName} has no field "${c.filters}"`);
    else if (!LIST_FILTER_KINDS.includes(kind)) issue([...path, "filters"], `a filter is an enum, a yes/no, a ref, a list or a date field: "${c.filters}" is ${kind}`);
    else if (!filterControlsOf(kind).includes(c.control))
      issue([...path, "control"], `a ${kind} field is filtered by ${filterControlsOf(kind).join(", ")}, not ${c.control}`);
    if (filtered.has(c.filters)) issue([...path, "filters"], `"${c.filters}" is filtered already (by filters or an earlier control)`);
    filtered.add(c.filters);
    const days = c.control === "calendar" || c.control === "date";
    if (c.multiple && days) issue([...path, "multiple"], `a ${c.control} picks one day`);
    if (c.source === undefined) return;
    const source = page.sources && Object.hasOwn(page.sources, c.source) ? page.sources[c.source] : undefined;
    const byDay = source !== undefined && "distinct" in source && source.by === "day";
    if (!source) issue([...path, "source"], `there is no source "${c.source}" on this page (sources: ${Object.keys(page.sources ?? {}).join(", ") || "none"})`);
    else if (c.control === "date") issue([...path, "source"], "a date input picks any day: it takes no source");
    else if (c.control === "calendar" && !byDay) issue([...path, "source"], "a calendar marks days: its source is { from, distinct: <a date field>, by: day }");
    else if (c.control !== "calendar" && byDay) issue([...path, "source"], `a source of days is for a calendar, not ${c.control}`);
  });
}

/** A report's measures each count one thing, on the type's fields and states; its shares and columns name its tiles. */
/** M65: a page's source reads a type of this App, by fields it has, never an encrypted one. M66: or a use, by its fields. */
function checkSource(
  app: { types: Record<string, DataType>; uses?: Record<string, AppUse> },
  source: PageSource,
  at: (string | number)[],
  issue: (path: (string | number)[], message: string) => void,
): void {
  const type = Object.hasOwn(app.types, source.from) ? app.types[source.from] : undefined;
  const use = !type && app.uses && Object.hasOwn(app.uses, source.from) ? app.uses[source.from] : undefined;
  if (use) return checkUseSource(source, use, at, issue);
  if (!type) return issue([...at, "from"], `there is no type "${source.from}" in this App (a source reads its own types and its uses)`);
  const kindOf = (name: string): FieldKind | undefined => (name.startsWith("@") ? "datetime" : type.fields[name]?.type);
  const field = (name: string, path: (string | number)[], kinds?: readonly FieldKind[], what?: string) => {
    const kind = kindOf(name);
    if (!kind) return issue(path, `${source.from} has no field "${name}"`);
    if (type.fields[name]?.encrypted) return issue(path, `${source.from}.${name} is encrypted: a source can't read it`);
    if (kinds && !kinds.includes(kind)) issue(path, `${what}: "${name}" is ${kind}`);
  };
  if ("distinct" in source) {
    field(source.distinct, [...at, "distinct"], DISTINCT_KINDS, "a source counts the values of a text, number, enum, yes/no, list, ref or date field");
    if (source.by) field(source.distinct, [...at, "by"], PERIOD_KINDS, "by day is a date's or a time's");
    return;
  }
  source.where?.forEach((condition, j) => field(condition.field, [...at, "where", j, "field"]));
  if (source.sort) field(source.sort.replace(/^-/, ""), [...at, "sort"]);
  if (source.id) field(source.id, [...at, "id"]);
  if (source.display) field(source.display, [...at, "display"]);
}

/**
 * M66: a source of a use names only the fields the use declares (their kinds are the chosen type's, known only once
 * it is chosen: the api reads them as the chosen type's).
 */
function checkUseSource(source: PageSource, use: AppUse, at: (string | number)[], issue: (path: (string | number)[], message: string) => void): void {
  const field = (name: string, path: (string | number)[]) => {
    if (!name.startsWith("@") && !use.fields.includes(name))
      issue(path, `${source.from} is read only by the fields it declares: "${name}" isn't one (${use.fields.join(", ")})`);
  };
  if ("distinct" in source) return field(source.distinct, [...at, "distinct"]);
  source.where?.forEach((condition, j) => field(condition.field, [...at, "where", j, "field"]));
  if (source.sort) field(source.sort.replace(/^-/, ""), [...at, "sort"]);
  if (source.id) field(source.id, [...at, "id"]);
  if (source.display) field(source.display, [...at, "display"]);
}

function checkReport(
  page: ReportPage,
  type: DataType,
  typeName: string,
  at: (string | number)[],
  field: (name: string, path: (string | number)[], kinds?: readonly FieldKind[], what?: string) => void,
  shown: (name: string, path: (string | number)[], where: string) => void,
  issue: (path: (string | number)[], message: string) => void,
): void {
  field(page.date, [...at, "date"], PERIOD_KINDS, "a report's date is a date field");
  const measure = (m: { count?: true; sum?: string; reached?: string | string[]; when?: Record<string, unknown> }, path: (string | number)[]) => {
    const kinds = [m.count, m.sum, m.reached].filter((k) => k !== undefined).length;
    if (kinds !== 1) issue(path, "one of count: true, sum: <field> or reached: <state>");
    if (m.sum !== undefined) shown(m.sum, [...path, "sum"], "summed");
    if (m.sum !== undefined && type.fields[m.sum] && !TOTAL_KINDS.includes(type.fields[m.sum].type))
      issue([...path, "sum"], `a sum is of a number or money field: "${m.sum}" is ${type.fields[m.sum].type}`);
    if (m.reached !== undefined) {
      if (!type.stages) issue([...path, "reached"], `${typeName} has no stages`);
      else
        for (const state of [m.reached].flat())
          if (!type.stages.states.includes(state)) issue([...path, "reached"], `"${state}" is not one of ${typeName}'s states`);
    }
    for (const name of Object.keys(m.when ?? {})) shown(name, [...path, "when", name], "a report's condition");
  };
  const labels = page.tiles.map((t) => t.label);
  const money = (label: string) => {
    const sum = page.tiles.find((t) => t.label === label)?.sum;
    return sum !== undefined && type.fields[sum]?.type === "money";
  };
  page.tiles.forEach((tile, j) => {
    const path = [...at, "tiles", j];
    measure(tile, path);
    if (labels.indexOf(tile.label) !== j) issue([...path, "label"], `"${tile.label}" is used by an earlier tile`);
    if (tile.of === undefined) return;
    if (tile.of === tile.label || !labels.includes(tile.of)) issue([...path, "of"], `"${tile.of}" is not another tile (tiles: ${labels.join(", ")})`);
    else if (money(tile.label) || money(tile.of)) issue([...path, "of"], "a share is of counts or number sums, not money");
  });
  page.trends.forEach((trend, j) => measure(trend, [...at, "trends", j]));
  page.tables.forEach((table, j) => {
    const path = [...at, "tables", j];
    shown(table.by, [...path, "by"], "a report's rows");
    if (table.bands) field(table.by, [...path, "bands"], TOTAL_KINDS, "bands are of a number or money field");
    table.columns.forEach((column, k) => {
      if (!labels.includes(column)) issue([...path, "columns", k], `"${column}" is not a tile (tiles: ${labels.join(", ")})`);
    });
  });
}

/**
 * A saved App version's definition, from the YAML it was saved as: a version's JSON copy is jsonb, which reorders keys,
 * and the order of the fields is the order they were written in (columns, forms).
 */
export function readAppSource(source: string): AppDefinition {
  return AppDefinitionSchema.parse(parseYaml(source));
}

/** M45: are its entities added and deleted by hand? A type of mine's always; another's when its list says `add`. */
export function addedByHand(app: { types: Record<string, DataType>; pages: AppPage[] }, typeName: string): boolean {
  if (app.types[typeName]?.mine) return true;
  return app.pages.some((p) => "list" in p && p.list === typeName && p.add);
}

/** The fields on an entity's form: as its form page says, or the fields of mine; never the stage, nor a key that stays. */
export function formFieldNames(type: DataType, form: FormPage | undefined): string[] {
  const names = form?.fields ?? Object.keys(type.fields).filter((name) => isMineField(type, name) && !(type.mine && name === type.key));
  return names.filter((name) => name !== type.stages?.field);
}

/** M45: the fields of the form that adds one by hand: a type of mine's every field; another's key, then its form's. */
export function addFieldNames(type: DataType, form: FormPage | undefined): string[] {
  // M48: a key Storm makes isn't asked for.
  const key = autoKey(type) ? [] : [type.key];
  if (type.mine) return Object.keys(type.fields).filter((name) => name !== type.stages?.field && !(autoKey(type) && name === type.key));
  return [...key, ...formFieldNames(type, form).filter((name) => name !== type.key)];
}

/** A field set on a form: one marked mine, or any of a type of mine, never the stage (moved by its buttons). */
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
  // M52: a sealed value goes only into an encrypted field, as it is (data.save seals it for its entity).
  if (holdsSealed(value))
    return field.encrypted && isSealed(value)
      ? { ok: true, value }
      : { ok: false, problem: "is an encrypted value: only an encrypted field keeps it" };
  const text = typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
  switch (field.type) {
    case "text":
    case "longtext": {
      if (text === null) return { ok: false, problem: "isn't text" };
      const max = field.type === "text" ? 1000 : 50_000;
      // M52: a secret cut short would be a wrong one: said, never cut.
      if (field.encrypted && text.length > max) return { ok: false, problem: `is longer than ${max} characters${field.type === "text" ? " (a longtext takes more)" : ""}` };
      return { ok: true, value: text.slice(0, max) };
    }
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
    case "list": {
      if (field.of === "text") {
        const texts = cleanTextList(field, value);
        return texts ? { ok: true, value: texts } : { ok: false, problem: "isn't a list of text" };
      }
      if (!Array.isArray(value)) return { ok: false, problem: "isn't a list" };
      if (field.of !== "ref") return { ok: true, value: value.slice(0, LIST_MAX) };
      // M56: keys of entities of its type (the api checks that they are), each once, in the order given.
      const keys = value.map((v) => (typeof v === "string" || typeof v === "number" ? String(v).trim() : ""));
      if (keys.some((k) => k === "")) return { ok: false, problem: "isn't a list of ones to point at" };
      return { ok: true, value: [...new Set(keys)].slice(0, 200) };
    }
    // M57: one of the user's credentials, by id (the api checks that it is theirs and allowed on its host).
    case "credential":
      return text !== null && UUID.test(text)
        ? { ok: true, value: text.toLowerCase() }
        : { ok: false, problem: "isn't one of your credentials" };
    // M55: the key of an entity of its type (the api checks that it is one).
    case "ref":
      return text !== null && text !== "" ? { ok: true, value: text.slice(0, 1000) } : { ok: false, problem: "isn't one to point at" };
    case "file":
    case "image": {
      // The api swaps the id for the stored file's reference, once it knows the file is this field's.
      const id = fileRefId(value);
      return id ? { ok: true, value: { id } } : { ok: false, problem: "isn't an uploaded file" };
    }
  }
}

const LINES = /\r?\n/;

/**
 * What the user typed on a form (M32), checked: only `allowed` fields, each as its kind; null or "" clears one, a
 * required one can't be cleared. Problems are said per field, and then nothing is saved.
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
    if (!value.ok) problems.push({ field: name, message: value.problem });
    // M65: a list of text left with nothing once cleaned (blank lines) is cleared.
    else if (Array.isArray(value.value) && value.value.length === 0 && isTextList(field)) {
      if (field.required) problems.push({ field: name, message: "is required" });
      else checked[name] = null;
    } else checked[name] = value.value;
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
    if ((raw === undefined || raw === null || raw === "") && name === type.key && field.auto) {
      // M48: a new entity's key, made here (a task from a message).
      setAt(value, name, newKey());
      continue;
    }
    if (raw === undefined || raw === null || raw === "") {
      deleteAt(value, name);
      // M56: a field the entity's other fields leave out (when) isn't required then.
      if ((field.required && fieldApplies(field, item)) || name === type.key) {
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
  // M52: a sealed value under a field the type doesn't name isn't kept.
  for (const name of Object.keys(value)) {
    // M71: what Storm says of an entity (data.read's "@stages") is never saved as one of its fields.
    if (name.startsWith("@")) {
      delete value[name];
      continue;
    }
    if (!(name in type.fields) && !Object.keys(type.fields).some((f) => f.startsWith(`${name}.`)) && holdsSealed(value[name])) {
      delete value[name];
      problems.push(`${name} is an encrypted value: only an encrypted field keeps it`);
    }
  }
  const keyValue = entityValueAt(value, type.key);
  const key = typeof keyValue === "string" ? keyValue : typeof keyValue === "number" ? String(keyValue) : null;
  return { value, key: rejected ? null : key, problems, rejected: rejected || key === null };
}

/** An entity as pipelines and pages see it: what pipelines wrote, with the fields of mine over it. */
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

/** One of an App's pipelines, and whether it being off matters. */
export interface AppPipelineView {
  pipelineId: string;
  name: string;
  enabled: boolean;
  /** Runs only while on (a schedule, an event, a command, a webhook); false: started by hand or by a button, on or off. */
  runsOnItsOwn: boolean;
  /** Its Telegram command (without the slash), which answers only while it is on. */
  command: string | null;
}

export interface AppSummaryView {
  appId: string;
  name: string;
  icon: (typeof VIEW_ICONS)[number];
  version: number | null;
  types: { name: string; entities: number }[];
  pipelines: AppPipelineView[];
  /** M40: the example it was installed from, if any: the gallery says it is installed. */
  example: string | null;
}

export interface AppVersionSummaryView {
  version: number;
  changeSummary: string | null;
  dateCreated: string;
}

/** M33-T5: a collection a pipeline's data.save kept (M13) that this App can take: "Move the "prices" collection here". */
export interface AppImportView {
  from: "collection";
  label: string;
  collection: string;
  /** How many there are to move (moved ones are skipped). */
  count: number;
}

/** A collection, into one of the App's types. */
export const AppImportRequestSchema = z
  .object({
    from: z.literal("collection").default("collection"),
    collection: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
    type: z.string().regex(TYPE_NAME),
  })
  .strict();
export type AppImportRequest = z.infer<typeof AppImportRequestSchema>;

export interface AppImportResult {
  moved: number;
  skipped: number;
}

/** M39-T2: the pipelines an App version's buttons run (`run:` of its pages' actions), by id: resolved when it is saved, or when they are. */
export interface AppRefs {
  pipelines: Record<string, string>;
}

/** M66: one of the user's Apps' types, as what fills a use. */
export interface AppUseSourceView {
  appId: string;
  /** The App's name now. */
  app: string;
  type: string;
}

/** M66: a use of another App's type, and which of the user's Apps fills it. */
/** M66: one of a ref's choices through a use: the chosen App's entity, by its key (what is saved) and title. */
export interface AppUseChoiceView {
  value: string;
  label: string;
}

export interface AppUseView {
  /** Its local name in the App. */
  name: string;
  use: AppUse;
  /** What fills it; null: not chosen yet (its pipelines can't read it). */
  source: AppUseSourceView | null;
  /** Why what fills it no longer fits (a field removed or encrypted since); empty: it fits. */
  problems: string[];
  /** The user's other Apps' types that fit it: the one `from` names first. */
  fits: AppUseSourceView[];
}

/** M66: `{ Bill: { appId, type } }` fills a use; null clears it. */
export const AppUsesRequestSchema = z.record(
  z.string().regex(TYPE_NAME),
  z.object({ appId: z.uuid(), type: z.string().regex(TYPE_NAME) }).strict().nullable(),
);
export type AppUsesRequest = z.infer<typeof AppUsesRequestSchema>;

/**
 * M66-T4: another App's use of one of this App's types: which App, its name for it, the type, the fields it reads;
 * in a draft's check, why the draft would no longer fit it.
 */
export interface AppUsedByView {
  appId: string;
  app: string;
  use: string;
  type: string;
  fields: string[];
  problems?: string[];
}

export interface AppDetailView extends AppSummaryView {
  definition: AppDefinition;
  /** M66-T4: the other Apps that read its types (`uses:`, this App chosen for them). */
  usedBy: AppUsedByView[];
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
 * M35-T4: a type drafted from a pasted sample: a list of items, an object holding one (an API's `{ results: [...] }`),
 * or a single item.
 */
export const DraftTypeSampleRequestSchema = z.object({ sample: z.unknown() }).strict();
export type DraftTypeSampleRequest = z.infer<typeof DraftTypeSampleRequestSchema>;

import { isMap, isPair, isScalar, isSeq, type Document, type Node, type YAMLMap } from "yaml";
import { editAppSource } from "./app-source";

/**
 * M35-T2: the App designer's changes to types and fields, each an edit of the App's YAML (its comments, order and the
 * lines it doesn't touch kept). A rename is renamed where the App uses it (key, title, a money field's currency, the
 * pages of its type); a removal is removed from the pages' lists. What a pipeline uses is not changed here: the check
 * says which ones a change breaks, before Save.
 */

type Path = (string | number)[];

/** A field as the designer sets it: a property given as undefined is removed. */
export interface FieldPatch {
  type?: string;
  label?: string;
  required?: boolean;
  mine?: boolean;
  values?: string[];
  currency?: string;
  /** M52: only on text and longtext. */
  encrypted?: boolean;
  /** M55: a ref's type. */
  to?: string;
  /** M56: what a list holds, refs (`to`); M65: or text, with `unique` (default true) and `caseSensitive`. */
  of?: "ref" | "text";
  unique?: boolean;
  caseSensitive?: boolean;
  /** M55: a line under its input. */
  help?: string;
}

export function addType(source: string, name: string, key = "name"): string {
  return editAppSource(source, (document) => {
    if (document.hasIn(["types", name])) throw new Error(`There is already a type ${name}`);
    if (!isMap(document.get("types", true))) document.set("types", document.createNode({}));
    const type = document.createNode({ key, fields: { [key]: { type: "text", required: true } } });
    flowFields(type);
    document.setIn(["types", name], type);
  });
}

/** The type renamed in place (where it was, with its comments), and on its pages. */
export function renameType(source: string, from: string, to: string): string {
  if (from === to) return source;
  return editAppSource(source, (document) => {
    if (document.hasIn(["types", to])) throw new Error(`There is already a type ${to}`);
    renameKey(document, ["types"], from, to);
    for (const page of pagesOf(document, from)) {
      for (const kind of ["list", "view", "form"]) if (page.has(kind)) page.set(kind, to);
    }
    // M65: a page's sources of it.
    for (const { source } of sourcesOf(document, from)) source.set("from", to);
  });
}

/** The type and its pages. */
export function removeType(source: string, name: string): string {
  return editAppSource(source, (document) => {
    document.deleteIn(["types", name]);
    for (const { page, name: source } of sourcesOf(document, name)) dropSource(page, source);
    const pages = document.get("pages", true);
    if (!isSeq(pages)) return;
    pages.items = pages.items.filter((page) => !(isMap(page) && ["list", "view", "form"].some((kind) => page.get(kind) === name)));
  });
}

/** key, title, mine or description of a type; undefined (or false for mine) removes it. */
export function setTypeProperty(
  source: string,
  type: string,
  property: "key" | "title" | "mine" | "description",
  value: string | boolean | undefined,
): string {
  return editAppSource(source, (document) => {
    if (value === undefined || value === false || value === "") document.deleteIn(["types", type, property]);
    else setInOrder(document, document.getIn(["types", type], true), property, value, ["description", "mine", "key", "title"]);
  });
}

export function addField(source: string, type: string, name: string, kind: string): string {
  return editAppSource(source, (document) => {
    if (document.hasIn(["types", type, "fields", name])) throw new Error(`${type} already has ${name}`);
    const field = document.createNode(kind === "enum" ? { type: kind, values: ["one", "two"] } : { type: kind });
    field.flow = true;
    if (!isMap(document.getIn(["types", type, "fields"], true))) document.setIn(["types", type, "fields"], document.createNode({}));
    document.setIn(["types", type, "fields", name], field);
  });
}

/**
 * A field's properties. A kind that can't have values or a currency loses them; an enum gets two values to rename,
 * as it needs some.
 */
export function setField(source: string, type: string, name: string, patch: FieldPatch): string {
  return editAppSource(source, (document) => {
    const at = ["types", type, "fields", name];
    const field = document.getIn(at, true);
    if (!isMap(field)) throw new Error(`${type} has no field ${name}`);
    const next = { ...(field.toJSON() as Record<string, unknown>), ...patch };
    if (next.type !== "enum") delete next.values;
    else if (!Array.isArray(next.values) || next.values.length === 0) next.values = ["one", "two"];
    if (next.type !== "money") delete next.currency;
    if (next.type !== "text" && next.type !== "longtext") delete next.encrypted;
    // M56: a list of refs keeps its type, as a ref does; `match` goes with it.
    const of = next.type === "list" ? next.of : undefined;
    const pointing = next.type === "ref" || of === "ref";
    if (!pointing) {
      delete next.to;
      field.delete("match");
    }
    setListOptions(field, of, next);
    for (const property of ["type", "label", "required", "mine", "values", "currency", "encrypted", "to", "help"] as const) {
      const value = next[property];
      if (value === undefined || value === false || value === "") field.delete(property);
      else if (property === "values") {
        const values = document.createNode(value);
        if (isSeq(values)) values.flow = true;
        field.set(property, values);
      } else field.set(property, value);
    }
  });
}

/** M65: a list's `of`, and a list of text's options written only when not their defaults (unique, not case-sensitive). */
function setListOptions(field: YAMLMap, of: unknown, next: Record<string, unknown>): void {
  if (of === "ref" || of === "text") field.set("of", of);
  else field.delete("of");
  const text = of === "text";
  if (text && next.unique === false) field.set("unique", false);
  else field.delete("unique");
  if (text && next.caseSensitive === true) field.set("caseSensitive", true);
  else field.delete("caseSensitive");
}

/** The field renamed in place, and wherever the App uses it: its type's key and title, currencies, its type's pages. */
export function renameField(source: string, type: string, from: string, to: string): string {
  if (from === to) return source;
  return editAppSource(source, (document) => {
    if (document.hasIn(["types", type, "fields", to])) throw new Error(`${type} already has ${to}`);
    renameKey(document, ["types", type, "fields"], from, to);
    for (const property of ["key", "title"])
      if (document.getIn(["types", type, property]) === from) document.setIn(["types", type, property], to);
    const fields = document.getIn(["types", type, "fields"], true);
    if (isMap(fields))
      for (const pair of fields.items) if (isMap(pair.value) && pair.value.get("currency") === from) pair.value.set("currency", to);
    for (const page of pagesOf(document, type)) renameOnPage(page, from, to);
    // M65: the sources of the type, on any page.
    for (const { source } of sourcesOf(document, type)) renameInSource(source, from, to);
  });
}

/** The field, and its place on its type's pages: in their lists, as their sort, the group by it. */
export function removeField(source: string, type: string, name: string): string {
  return editAppSource(source, (document) => {
    document.deleteIn(["types", type, "fields", name]);
    for (const page of pagesOf(document, type)) removeFromPage(page, name);
    // M65: a source counting it goes (its controls then use their own values); one naming it otherwise loses that.
    for (const { page, name: source, source: node } of sourcesOf(document, type)) {
      if (node.get("distinct") === name) dropSource(page, source);
      else removeFromSource(node, name);
    }
  });
}

function renameInSource(source: YAMLMap, from: string, to: string): void {
  for (const key of ["distinct", "id", "display"]) if (source.get(key) === from) source.set(key, to);
  const sort = source.get("sort");
  if (sort === from || sort === `-${from}`) source.set("sort", String(sort).replace(from, to));
  const where = source.get("where", true);
  if (isSeq(where)) for (const condition of where.items) if (isMap(condition) && condition.get("field") === from) condition.set("field", to);
}

function removeFromSource(source: YAMLMap, name: string): void {
  for (const key of ["id", "display"]) if (source.get(key) === name) source.delete(key);
  const sort = source.get("sort");
  if (sort === name || sort === `-${name}`) source.delete("sort");
  const where = source.get("where", true);
  if (!isSeq(where)) return;
  where.items = where.items.filter((condition) => !(isMap(condition) && condition.get("field") === name));
  if (where.items.length === 0) source.delete("where");
}

/** M65: the list pages' sources that read a type, on any page (a source may read another of the App's types). */
function sourcesOf(document: Document, type: string): { page: YAMLMap; name: string; source: YAMLMap }[] {
  const pages = document.get("pages", true);
  if (!isSeq(pages)) return [];
  return pages.items.flatMap((page) => {
    const sources = isMap(page) ? page.get("sources", true) : undefined;
    if (!isMap(page) || !isMap(sources)) return [];
    return sources.items.flatMap((pair) =>
      isScalar(pair.key) && isMap(pair.value) && pair.value.get("from") === type ? [{ page, name: String(pair.key.value), source: pair.value }] : [],
    );
  });
}

/** M65: a page's source removed; its controls take their own values instead. */
function dropSource(page: YAMLMap, name: string): void {
  const sources = page.get("sources", true);
  if (isMap(sources)) {
    sources.delete(name);
    if (sources.items.length === 0) page.delete("sources");
  }
  const controls = page.get("controls", true);
  if (isSeq(controls)) for (const control of controls.items) if (isMap(control) && control.get("source") === name) control.delete("source");
}

/** A type's fields a line each, as the templates are written: id: { type: text, required: true } */
export function flowFields(type: Node): void {
  const fields = isMap(type) ? type.get("fields", true) : undefined;
  if (isMap(fields)) for (const pair of fields.items) if (isMap(pair.value)) pair.value.flow = true;
}

function renameKey(document: Document, at: Path, from: string, to: string): void {
  const map = document.getIn(at, true);
  const pair = isMap(map) ? map.items.find((p) => isScalar(p.key) && p.key.value === from) : undefined;
  if (!pair || !isScalar(pair.key)) throw new Error(`There is no ${from}`);
  pair.key.value = to;
}

function pagesOf(document: Document, type: string): YAMLMap[] {
  const pages = document.get("pages", true);
  if (!isSeq(pages)) return [];
  return pages.items.filter((page): page is YAMLMap => isMap(page) && ["list", "view", "form"].some((kind) => page.get(kind) === type));
}

/** Where a page names a field: in lists, as a column's or total's field, in sort and group, in conditions' keys. */
function renameOnPage(page: YAMLMap, from: string, to: string): void {
  const scalar = (value: unknown) => isScalar(value) && value.value === from;
  const inList = (node: unknown) => {
    if (!isSeq(node)) return;
    node.items.forEach((item, i) => {
      if (scalar(item)) node.set(i, to);
      else if (isMap(item)) {
        if (item.get("field") === from) item.set("field", to);
        conditions(item.get("when", true));
        const due = item.get("due", true);
        if (isMap(due)) conditions(due.get("unless", true));
      }
    });
  };
  const conditions = (node: unknown) => {
    if (!isMap(node)) return;
    for (const pair of node.items) if (isPair(pair) && isScalar(pair.key) && pair.key.value === from) pair.key.value = to;
  };
  for (const list of ["columns", "filters", "search", "fields"]) inList(page.get(list, true));
  const sort = page.get("sort");
  if (sort === from || sort === `-${from}`) page.set("sort", String(sort).replace(from, to));
  const group = page.get("group", true);
  if (isMap(group)) {
    if (group.get("by") === from) group.set("by", to);
    inList(group.get("totals", true));
  }
  const sections = page.get("sections", true);
  if (isSeq(sections)) for (const section of sections.items) if (isMap(section)) inList(section.get("fields", true));
  const actions = page.get("actions", true);
  if (isSeq(actions)) for (const action of actions.items) if (isMap(action)) conditions(action.get("when", true));
  // M65: a filter's control.
  const controls = page.get("controls", true);
  if (isSeq(controls)) for (const control of controls.items) if (isMap(control) && control.get("filters") === from) control.set("filters", to);
}

function removeFromPage(page: YAMLMap, name: string): void {
  const named = (item: unknown) => (isScalar(item) && item.value === name) || (isMap(item) && item.get("field") === name);
  // A list left empty goes: the page's default takes its place (a section with no fields goes with them).
  const without = (parent: YAMLMap, key: string) => {
    const node = parent.get(key, true);
    if (!isSeq(node)) return;
    node.items = node.items.filter((item) => !named(item));
    if (node.items.length === 0) parent.delete(key);
  };
  for (const list of ["columns", "filters", "search", "fields"]) without(page, list);
  const sort = page.get("sort");
  if (sort === name || sort === `-${name}`) page.delete("sort");
  const group = page.get("group", true);
  if (isMap(group) && group.get("by") === name) page.delete("group");
  else if (isMap(group)) without(group, "totals");
  // M65: a control filtering by it.
  const controls = page.get("controls", true);
  if (isSeq(controls)) {
    controls.items = controls.items.filter((control) => !(isMap(control) && control.get("filters") === name));
    if (controls.items.length === 0) page.delete("controls");
  }
  const sections = page.get("sections", true);
  if (isSeq(sections)) {
    for (const section of sections.items) if (isMap(section)) without(section, "fields");
    sections.items = sections.items.filter((section) => !isMap(section) || section.has("fields"));
    if (sections.items.length === 0) page.delete("sections");
  }
}

/** The App's name, description or icon; an empty description removes it. */
export function setAppProperty(source: string, property: "name" | "description" | "icon", value: string): string {
  return editAppSource(source, (document) => {
    if (value === "" && property === "description") document.delete(property);
    else setInOrder(document, document.contents, property, value, ["name", "description", "icon"]);
  });
}

/**
 * A property set where it is, or a new one where it would be written: after the ones before it in `order` that are
 * there (a type's title after its key), else first.
 */
function setInOrder(document: Document, node: unknown, property: string, value: unknown, order: string[]): void {
  if (!isMap(node)) throw new Error(`Nothing to set ${property} on`);
  if (node.has(property)) {
    node.set(property, value);
    return;
  }
  const before = order.slice(0, order.indexOf(property));
  const index = node.items.reduce((at, pair, i) => (isScalar(pair.key) && before.includes(String(pair.key.value)) ? i + 1 : at), 0);
  node.items.splice(index, 0, document.createPair(property, value));
}

/** A drafted field as it would be written (M35-T4): its kind, and only what isn't a default. */
export interface DraftedField {
  type: string;
  label?: string;
  required?: boolean;
  values?: string[];
  currency?: string;
}

/**
 * M35-T4: the fields kept from a draft, as a new type (its key one of them) or added to a type that is there (the
 * ones it has left as they are). A money field's currency it no longer has is dropped.
 */
export function addDraftedFields(source: string, type: string, fields: Record<string, DraftedField>, key?: string, title?: string): string {
  return editAppSource(source, (document) => {
    const existing = document.getIn(["types", type, "fields"], true);
    const have = isMap(existing) ? existing.items.map((p) => String(isScalar(p.key) ? p.key.value : p.key)) : [];
    const kept = Object.keys(fields);
    const node = (field: DraftedField) => {
      const { type: kind, label, required, values, currency } = field;
      const authored = {
        type: kind,
        ...(label ? { label } : {}),
        ...(required ? { required: true } : {}),
        ...(values ? { values } : {}),
        ...(currency && (kept.includes(currency) || have.includes(currency)) ? { currency } : {}),
      };
      const made = document.createNode(authored);
      flowMove(made);
      return made;
    };
    if (!isMap(existing)) {
      if (document.hasIn(["types", type])) throw new Error(`${type} has no fields to add to`);
      if (!key || !(key in fields)) throw new Error("Keep the field that tells them apart, as its key");
      if (!isMap(document.get("types", true))) document.set("types", document.createNode({}));
      const made = document.createNode({ key, ...(title && title in fields ? { title } : {}), fields: {} }) as YAMLMap;
      const madeFields = made.get("fields", true);
      if (!isMap(madeFields)) return;
      madeFields.flow = false;
      for (const [name, field] of Object.entries(fields)) madeFields.set(name, node(field));
      document.setIn(["types", type], made);
      return;
    }
    for (const [name, field] of Object.entries(fields)) if (!have.includes(name)) existing.set(name, node(field));
  });
}

function flowMove(node: unknown): void {
  if (!isMap(node)) return;
  node.flow = true;
  for (const pair of node.items) if (isSeq(pair.value)) pair.value.flow = true;
}

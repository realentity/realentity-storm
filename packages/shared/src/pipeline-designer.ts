import { isMap, isScalar, isSeq, parseDocument, visit, type Document, type YAMLMap, type YAMLSeq } from "yaml";
import { editAppSource, keepComment } from "./app-source";
import { RESERVED_STEP_IDS, STEP_ID } from "./pipeline";

/**
 * M36-T2: the step builder's changes to a pipeline, each an edit of its YAML (my comments, order and the lines it
 * doesn't touch kept, as the App designer's). A step renamed is renamed in every {{reference}} to it.
 */

/** A step's id from its type: its last part (email.fetch → fetch), numbered when it is taken (fetch2). */
export function stepIdFor(type: string, taken: string[]): string {
  const last = type.split(".").at(-1) ?? "step";
  let base = last.replaceAll(/[^A-Za-z0-9_]/g, "");
  if (!/^[a-z]/.test(base)) base = `s${base}`;
  base = base.slice(0, 36);
  if ((RESERVED_STEP_IDS as readonly string[]).includes(base)) base = `${base}Step`;
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}${n}`)) return `${base}${n}`;
}

/** A step of that type, its inputs to fill, after `after` (else at the end). */
export function addStep(source: string, type: string, after?: number): string {
  return editAppSource(source, (document) => {
    const steps = stepsOf(document, true);
    const id = stepIdFor(type, ids(steps));
    const step = document.createNode({ id, type, with: {} }) as YAMLMap;
    const index = after === undefined ? steps.items.length : Math.min(after + 1, steps.items.length);
    steps.items.splice(index, 0, step);
  });
}

export function removeStep(source: string, index: number): string {
  return editAppSource(source, (document) => {
    const steps = stepsOf(document);
    if (steps.items.length <= 1) throw new Error("A pipeline needs a step");
    steps.items.splice(index, 1);
  });
}

/** A step one place earlier or later. */
export function moveStep(source: string, index: number, by: -1 | 1): string {
  return editAppSource(source, (document) => {
    const steps = stepsOf(document);
    const j = index + by;
    if (j < 0 || j >= steps.items.length) return;
    [steps.items[index], steps.items[j]] = [steps.items[j], steps.items[index]];
  });
}

/** The step's id, and every {{from…}} in the pipeline with it. */
export function renameStep(source: string, index: number, to: string): string {
  return editAppSource(source, (document) => {
    const steps = stepsOf(document);
    const step = steps.items[index];
    if (!isMap(step)) throw new Error("There is no such step");
    const from = String(step.get("id"));
    if (from === to) return;
    if (!STEP_ID.test(to) || (RESERVED_STEP_IDS as readonly string[]).includes(to)) throw new Error(`"${to}" can't be a step's id`);
    if (ids(steps).includes(to)) throw new Error(`There is already a step ${to}`);
    step.set("id", to);
    renameReferences(document, from, to);
  });
}

/**
 * One of a step's inputs (`with`): undefined removes it. A value that is text, a number or yes/no is written as it is,
 * a list or an object on its own lines unless short.
 */
export function setStepInput(source: string, index: number, field: string, value: unknown): string {
  return editAppSource(source, (document) => {
    const step = stepAt(document, index);
    const existing = step.get("with", true);
    if (value === undefined) {
      if (isMap(existing)) existing.delete(field);
      return;
    }
    let withNode: YAMLMap;
    if (isMap(existing)) withNode = existing;
    else {
      withNode = document.createNode({});
      withNode.flow = false;
      step.set("with", withNode);
    }
    const node = quoted(document.createNode(value));
    if ((isSeq(node) || isMap(node)) && JSON.stringify(value).length <= 60 && !hasObjects(value)) node.flow = true;
    // A value with objects in it on its own lines: a flow `with: {}` can't hold them readably.
    if (hasObjects(value) || ((isSeq(node) || isMap(node)) && !node.flow)) withNode.flow = false;
    keepComment(withNode.get(field, true), node);
    withNode.set(field, node);
  });
}

/** A step's `when`, `forEach` or `retries`: undefined removes it. Placed before its `with`, as I'd write them. */
export function setStepOption(
  source: string,
  index: number,
  option: "when" | "forEach" | "retries",
  value: string | number | undefined,
): string {
  return editAppSource(source, (document) => {
    const step = stepAt(document, index);
    if (value === undefined || value === "") {
      step.delete(option);
      return;
    }
    const node = quoted(document.createNode(value));
    if (step.has(option)) {
      keepComment(step.get(option, true), node);
      step.set(option, node);
      return;
    }
    const at = step.items.findIndex((pair) => isScalar(pair.key) && pair.key.value === "with");
    step.items.splice(at < 0 ? step.items.length : at, 0, document.createPair(option, node));
  });
}

/** The trigger, whole: "manual", or its map (a schedule, an event, a webhook), on one line. */
export function setTrigger(source: string, trigger: unknown): string {
  return editAppSource(source, (document) => {
    const node = quoted(document.createNode(trigger));
    if (isMap(node)) {
      node.flow = true;
      for (const pair of node.items) if (isSeq(pair.value)) pair.value.flow = true;
    }
    if (document.has("trigger")) {
      keepComment(document.get("trigger", true), node);
      document.set("trigger", node);
      return;
    }
    // Where the templates have it: before the steps.
    const root = document.contents;
    if (!isMap(root)) throw new Error("A pipeline is a map");
    const at = root.items.findIndex((pair) => isScalar(pair.key) && pair.key.value === "steps");
    root.items.splice(at < 0 ? root.items.length : at, 0, document.createPair("trigger", node));
  });
}

/** The pipeline's name, description or App: an empty description or App removes it. New ones go after the name. */
export function setPipelineProperty(source: string, property: "name" | "description" | "app", value: string): string {
  return editAppSource(source, (document) => {
    if (value === "" && property !== "name") {
      document.delete(property);
      return;
    }
    if (document.has(property)) {
      document.set(property, value);
      return;
    }
    const root = document.contents;
    if (!isMap(root)) throw new Error("A pipeline is a map");
    const order = ["name", "app", "description"];
    const before = order.slice(0, order.indexOf(property));
    const at = root.items.reduce((i, pair, n) => (isScalar(pair.key) && before.includes(String(pair.key.value)) ? n + 1 : i), 0);
    root.items.splice(at, 0, document.createPair(property, value));
  });
}

/**
 * A site the pipeline may read (policy.allowedDomains), from its card: added once, the policy made before the steps
 * when it has none. Removed with `allow: false`.
 */
export function allowDomain(source: string, host: string, allow = true): string {
  const domain = host.trim().toLowerCase();
  return editAppSource(source, (document) => {
    const root = document.contents;
    if (!isMap(root)) throw new Error("A pipeline is a map");
    const found: unknown = root.get("policy", true);
    let map: YAMLMap;
    if (isMap(found)) map = found;
    else {
      if (!allow) return;
      map = document.createNode({});
      map.flow = false;
      const at = root.items.findIndex((pair) => isScalar(pair.key) && pair.key.value === "steps");
      root.items.splice(at < 0 ? root.items.length : at, 0, document.createPair("policy", map));
    }
    const listed: unknown = map.get("allowedDomains", true);
    let list: YAMLSeq;
    if (isSeq(listed)) list = listed;
    else {
      if (!allow) return;
      list = document.createNode([]);
      list.flow = true;
      map.set("allowedDomains", list);
    }
    const at = list.items.findIndex((item) => isScalar(item) && String(item.value).toLowerCase() === domain);
    if (allow && at < 0) list.items.push(document.createNode(domain));
    if (!allow && at >= 0) list.items.splice(at, 1);
  });
}

/** The sites a pipeline may read, as its policy lists them. */
export function allowedDomainsOf(source: string): string[] {
  try {
    const parsed = parseDocument(source).toJS() as { policy?: { allowedDomains?: unknown } } | null;
    const domains = parsed?.policy?.allowedDomains;
    return Array.isArray(domains) ? domains.map(String) : [];
  } catch {
    return [];
  }
}

/** The host a card's problem says isn't allowed ("www.example.org isn't in policy.allowedDomains"), to allow it. */
export function notAllowedHost(message: string): string | null {
  return /^(\S+) isn't in policy\.allowedDomains/.exec(message)?.[1] ?? null;
}

/** My comment on the value a change replaces, on the new one. */
/** Every {{from}} and {{from.…}} in the pipeline's text, as {{to…}}. */
function renameReferences(document: Document, from: string, to: string): void {
  const pattern = new RegExp(`\\{\\{(\\s*)${escapeRegExp(from)}(?=\\s*(?:\\.|\\[|\\}\\}))`, "g");
  visit(document, {
    Scalar(_, node) {
      if (typeof node.value === "string" && node.value.includes("{{")) node.value = node.value.replace(pattern, `{{$1${to}`);
    },
  });
}

/** Text with a template or a cron's stars in it, quoted, as the templates write it ("{{fetch.messages}}", "0 8 * * *"). */
function quoted<T>(node: T): T {
  visit(node as never, {
    Scalar(_, scalar) {
      if (typeof scalar.value === "string" && /\{\{|\*/.test(scalar.value)) scalar.type = "QUOTE_DOUBLE";
    },
  });
  return node;
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stepsOf(document: Document, create = false): YAMLSeq {
  const steps = document.get("steps", true);
  if (isSeq(steps)) return steps;
  if (!create) throw new Error("The pipeline has no steps");
  const made = document.createNode([]) as YAMLSeq;
  document.set("steps", made);
  return made;
}

function stepAt(document: Document, index: number): YAMLMap {
  const step = stepsOf(document).items[index];
  if (!isMap(step)) throw new Error("There is no such step");
  return step;
}

function ids(steps: YAMLSeq): string[] {
  return steps.items.flatMap((s) => (isMap(s) && s.get("id") !== undefined ? [String(s.get("id"))] : []));
}

function hasObjects(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((v) => v !== null && typeof v === "object");
  if (value && typeof value === "object") return Object.values(value).some((v) => v !== null && typeof v === "object");
  return false;
}

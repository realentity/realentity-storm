import { Document, isMap, isScalar, isSeq, LineCounter, parseAllDocuments, parseDocument, type Pair, type YAMLMap } from "yaml";
import { z } from "zod";
import { type AppIssue } from "./app";
import { lineAt } from "./app-source";
import { type BundleDocument } from "./bundle";
import { ExampleNeedSchema, type ExampleNeed } from "./examples";

/**
 * An App and its pipelines as one YAML file: `app:` (its name, description, icon, slots and what to set up first), its
 * `types:` and `pages:`, and its `pipelines:` by a key of the file's own. It is a file format only: an import reads it as
 * the App and the pipelines Storm keeps apart, each key replaced by the pipeline's name, and an export writes it back.
 *
 *   app: { name: Lockbox, setup: [...] }
 *   types: ...
 *   pages:
 *     - view: Bundle
 *       actions: [{ label: Sync, run: sync }]
 *   pipelines:
 *     sync: { name: Sync, trigger: ..., steps: [...] }   # saved as "Lockbox · Sync"
 */

const JOIN = " · ";
/** What moves under `app:`; the rest of an App's YAML stays at the top of the file. */
const APP_KEYS = new Set(["name", "description", "icon", "needs"]);
const PIPELINE_KEY = /^[a-z][A-Za-z0-9_-]{0,39}$/;
const PIPELINE_NAME = z.string().trim().min(1).max(100);

const PackagePipelineSchema = z
  .looseObject({
    name: PIPELINE_NAME.optional(),
    /** The name it is saved under when that isn't "<App> · <name>": a pipeline exported as it is. */
    fullName: PIPELINE_NAME.optional(),
  })
  .refine((p) => (p.name === undefined) !== (p.fullName === undefined), "a pipeline has a name")
  .refine((p) => !("app" in p), "a pipeline here belongs to this App: leave out its app");

const AppPackageSchema = z
  .object({
    // The other fields are the App's own, checked as an App.
    app: z.looseObject({
      name: z.string().trim().min(1),
      /** What to set up before its pipelines can run: the checklist on its page. */
      setup: z.array(ExampleNeedSchema).max(10).optional(),
      /** What the gallery says of it; default: its description. */
      summary: z.string().trim().min(1).max(300).optional(),
      /** First in the gallery: needs nothing set up. */
      starter: z.boolean().optional(),
    }),
    types: z.unknown(),
    pages: z.unknown().optional(),
    pipelines: z.record(z.string().regex(PIPELINE_KEY, 'a key, e.g. "sync": a small letter, then letters and digits'), PackagePipelineSchema).optional(),
  })
  .strict();

export interface AppPackage {
  /** The App as written under it, as the name it has in the file. */
  name: string;
  /** The App, then its pipelines, as an import of separate documents would have them. */
  documents: BundleDocument[];
  setup: ExampleNeed[] | null;
  errors: AppIssue[];
}

/** One document whose top has `app:` as a map: a pipeline's `app:` is the name of one. */
export function isAppPackage(text: string): boolean {
  const documents = parseAllDocuments(text);
  if (!Array.isArray(documents) || documents.length !== 1 || documents[0].errors.length > 0) return false;
  const root = documents[0].contents;
  return isMap(root) && isMap(root.get("app", true));
}

/** The file as Storm's App and pipelines; `appName`: under this name instead (a copy). */
export function readAppPackage(text: string, appName?: string): AppPackage {
  const lines = new LineCounter();
  const original = parseDocument(text, { lineCounter: lines, prettyErrors: false });
  const checked = AppPackageSchema.safeParse(original.toJS());
  if (!checked.success) {
    const errors = checked.error.issues.map((issue) => {
      const path = issue.path.map((p) => (typeof p === "symbol" ? String(p) : p));
      return { path: path.join("."), message: issue.message, line: lineAt(original, lines, path) };
    });
    return { name: "", documents: [], setup: null, errors };
  }
  const name = appName ?? checked.data.app.name;
  const pipelines = Object.entries(checked.data.pipelines ?? {});
  const names = new Map(pipelines.map(([key, p]) => [key, p.fullName ?? `${name}${JOIN}${p.name}`]));

  const flat = parseDocument(text);
  const root = flat.contents as YAMLMap;
  const head = root.get("app", true) as unknown as YAMLMap;
  const written = root.get("pipelines", true);
  head.set("name", name);
  head.delete("setup");
  head.delete("starter");
  head.delete("summary");
  keepFirstComment(root.items[0], head.items[0]);
  root.items = [...head.items, ...root.items.filter((pair) => !["app", "pipelines"].includes(keyOfPair(pair)))];
  renameButtons(root, names);

  const documents: BundleDocument[] = [
    {
      kind: "app",
      name,
      source: flat.toString({ lineWidth: 0 }),
      line: 1,
      lineOf: (path) => {
        const parts = path.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part));
        return lineAt(original, lines, APP_KEYS.has(String(parts[0])) ? ["app", ...parts] : parts);
      },
    },
  ];
  for (const pair of isMap(written) ? written.items : []) {
    const key = keyOfPair(pair);
    const node = pair.value as YAMLMap;
    node.delete("name");
    node.delete("fullName");
    const document = new Document();
    document.contents = node;
    node.items.unshift(document.createPair("name", names.get(key)), document.createPair("app", name));
    renameReferences(node, names);
    const line = lineAt(original, lines, ["pipelines", key]) ?? 1;
    documents.push({ kind: "pipeline", key, name: names.get(key), source: document.toString({ lineWidth: 0 }), line, lineOf: () => line });
  }
  return { name: checked.data.app.name, documents, setup: checked.data.app.setup ?? null, errors: [] };
}

/** An App's YAML and its pipelines' as one file: what `readAppPackage` reads back as they are. */
export function toAppPackage(appSource: string, pipelineSources: string[], setup?: ExampleNeed[] | null): string {
  const document = parseDocument(appSource);
  const root = document.contents as YAMLMap;
  const appName = String(root.get("name"));
  const prefix = `${appName}${JOIN}`;
  const used = new Set<string>();
  const parsed = pipelineSources.map((source) => {
    const node = parseDocument(source).contents as YAMLMap;
    const fullName = String(node.get("name"));
    const short = fullName.startsWith(prefix) ? fullName.slice(prefix.length) : null;
    return { node, fullName, short, key: pipelineKey(short ?? fullName, used) };
  });
  const keys = new Map(parsed.map((p) => [p.fullName, p.key]));

  const app = document.createNode({}) as YAMLMap;
  app.items = root.items.filter((pair) => APP_KEYS.has(keyOfPair(pair)));
  const rest = root.items.filter((pair) => !APP_KEYS.has(keyOfPair(pair)));
  if (setup?.length) app.set("setup", document.createNode(setup));
  renameButtons(root, keys);

  const pipelines = document.createNode({}) as YAMLMap;
  for (const { node, fullName, short, key } of parsed) {
    node.delete("name");
    node.delete("app");
    node.items.unshift(short ? document.createPair("name", short) : document.createPair("fullName", fullName));
    renameReferences(node, keys);
    pipelines.items.push(document.createPair(key, node));
  }
  const appPair = document.createPair("app", app);
  keepFirstComment(app.items[0], appPair);
  root.items = [appPair, ...rest, ...(parsed.length > 0 ? [document.createPair("pipelines", pipelines)] : [])];
  return document.toString({ lineWidth: 0 });
}

function keyOfPair(pair: Pair): string {
  return isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
}

/** The comment above the file's first key stays above the first key after the move. */
function keepFirstComment(from: Pair | undefined, to: Pair | undefined): void {
  if (!from || !to || !isScalar(from.key) || !isScalar(to.key) || !from.key.commentBefore) return;
  (to.key).commentBefore = from.key.commentBefore;
  from.key.commentBefore = undefined;
}

function rename(map: unknown, key: string, names: Map<string, string | undefined>): void {
  if (!isMap(map)) return;
  const value = map.get(key, true);
  const to = isScalar(value) && typeof value.value === "string" ? names.get(value.value) : undefined;
  if (to && isScalar(value)) value.value = to;
}

/** Each page's buttons: `run:`. */
function renameButtons(root: YAMLMap, names: Map<string, string | undefined>): void {
  const pages = root.get("pages", true);
  if (!isSeq(pages)) return;
  for (const page of pages.items) {
    const actions = isMap(page) ? page.get("actions", true) : null;
    if (isSeq(actions)) for (const action of actions.items) rename(action, "run", names);
  }
}

/** A pipeline's trigger on another (run.finished) and its flow.later steps. */
function renameReferences(node: YAMLMap, names: Map<string, string | undefined>): void {
  const trigger = node.get("trigger", true);
  if (isMap(trigger) && trigger.get("on") === "run.finished") rename(trigger, "pipeline", names);
  const steps = node.get("steps", true);
  if (!isSeq(steps)) return;
  for (const step of steps.items) if (isMap(step) && step.get("type") === "flow.later") rename(step.get("with", true), "pipeline", names);
}

/** "Disk prices" → diskPrices, one the file doesn't use yet. */
function pipelineKey(name: string, used: Set<string>): string {
  const words = name.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const joined = words.map((word, i) => (i === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1))).join("").slice(0, 36) || "pipeline";
  const base = /^[a-z]/.test(joined) ? joined : `p${joined}`;
  let key = base;
  for (let n = 2; used.has(key); n++) key = `${base}${n}`;
  used.add(key);
  return key;
}

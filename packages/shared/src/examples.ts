import { isMap, isScalar, isSeq, parse } from "yaml";
import { z } from "zod";
import { editAppSource } from "./app-source";
import { type BundleDocument } from "./bundle";

/**
 * M40: the examples on the Apps page (examples/apps): an App with the pipelines that fill it in one file, installed
 * together, and what has to be set up before its pipelines can run.
 */

/** M50: no `credential` need: an example's credentials are its App's and pipelines' slots, chosen when it is installed. */
export const EXAMPLE_NEED_KINDS = ["email", "google-calendar", "telegram", "llm", "recipe", "entities"] as const;
export type ExampleNeedKind = (typeof EXAMPLE_NEED_KINDS)[number];

export const ExampleNeedSchema = z
  .object({
    kind: z.enum(EXAMPLE_NEED_KINDS),
    /** credential, recipe: which one. */
    name: z.string().min(1).max(100).optional(),
    /** entities: of which type (of the App). */
    type: z.string().min(1).max(60).optional(),
    label: z.string().min(1).max(200),
  })
  .strict()
  .refine((n) => n.kind !== "recipe" || n.name, "a recipe need names it")
  .refine((n) => n.kind !== "entities" || n.type, "an entities need names its type");
export type ExampleNeed = z.infer<typeof ExampleNeedSchema>;

export const ExampleSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/),
    name: z.string().min(1).max(60),
    description: z.string().min(1).max(300),
    /** First in the gallery: needs nothing set up. */
    starter: z.boolean().default(false),
    needs: z.array(ExampleNeedSchema).max(10),
    /** Its file, as written: what is installed. */
    text: z.string().min(1),
  })
  .strict();
export type Example = z.output<typeof ExampleSchema>;

/** M40-T2: what is set up, for the examples' needs: the server's (email, Telegram, the LLM) and the user's. */
export interface SetupView {
  /** Set up, and the last time mail was read it worked. */
  email: boolean;
  /** Set up, but the last time mail was read it failed (a password Gmail no longer takes): why. */
  emailProblem: string | null;
  googleCalendar: boolean;
  telegram: boolean;
  llm: boolean;
  credentials: string[];
  recipes: string[];
}

/** M40-T3: what is left before an installed example works: its needs, then trying and switching on its pipelines. */
export interface ChecklistView {
  example: string;
  items: { label: string; done: boolean; /** Where it is done. */ link: string | null; /** Said when there is no link. */ note?: string }[];
  done: boolean;
}

/** M40-T2: is this need met by what is set up? `entities`: how many of its type the App has. */
export function needMet(need: ExampleNeed, setup: SetupView, entities = 0): boolean {
  switch (need.kind) {
    case "email":
      return setup.email;
    case "google-calendar":
      return setup.googleCalendar;
    case "telegram":
      return setup.telegram;
    case "llm":
      return setup.llm;
    case "recipe":
      return setup.recipes.includes(need.name!);
    case "entities":
      return entities > 0;
  }
}

/** One App's file as an example: `id` is the file's name. */
function readExample(id: string, text: string): Example {
  const { app } = parse(text) as { app: { name: string; description?: string; summary?: string; starter?: boolean; setup?: ExampleNeed[] } };
  return ExampleSchema.parse({
    id,
    name: app.name,
    description: app.summary ?? app.description,
    starter: app.starter ?? false,
    needs: app.setup ?? [],
    text,
  });
}

/** The App files by id, as examples: the starter first, then by name. */
export function readExamples(files: Record<string, string>): Example[] {
  return Object.entries(files)
    .map(([id, text]) => readExample(id, text))
    .sort((a, b) => Number(b.starter) - Number(a.starter) || a.name.localeCompare(b.name));
}

/** The name, or the first of its numbered ones not used yet. */
export function freeName(name: string, used: string[], numbered: (n: number) => string): string {
  if (!used.includes(name)) return name;
  let n = 2;
  while (used.includes(numbered(n))) n++;
  return numbered(n);
}

/**
 * M40-T2: an example installed again: its App and pipelines under names not taken yet ("Bills 2": an App's name has no
 * brackets; "Bills (2)" for a pipeline, as M39 named duplicates), and what refers to
 * them renamed with them (a pipeline's `app:`, a button's `run:`, run.finished's and flow.later's `pipeline`), the
 * comments kept. Installed the first time, the documents are as they are.
 */
export function freeNames(documents: BundleDocument[], taken: { apps: string[]; pipelines: string[] }): string[] {
  const apps = new Map<string, string>();
  const pipelines = new Map<string, string>();
  for (const document of documents) {
    if (!document.name) continue;
    const name = document.name;
    if (document.kind === "app")
      apps.set(
        name,
        freeName(name, taken.apps, (n) => `${name} ${n}`),
      );
    if (document.kind === "pipeline")
      pipelines.set(
        name,
        freeName(name, taken.pipelines, (n) => `${name} (${n})`),
      );
  }
  const renamed = (map: Map<string, string>, value: unknown) =>
    typeof value === "string" && map.has(value) && map.get(value) !== value ? map.get(value)! : null;

  return documents.map((document) => {
    const changes = [...apps, ...pipelines].some(([from, to]) => from !== to);
    if (!changes) return document.source;
    return editAppSource(document.source, (doc) => {
      const set = (node: unknown, key: string, map: Map<string, string>) => {
        if (!isMap(node)) return;
        const value = node.get(key, true);
        const to = isScalar(value) ? renamed(map, value.value) : null;
        if (to && isScalar(value)) value.value = to;
      };
      const root = doc.contents;
      set(root, "name", document.kind === "app" ? apps : pipelines);
      if (document.kind === "pipeline") {
        set(root, "app", apps);
        if (isMap(root)) {
          const trigger = root.get("trigger", true);
          if (isMap(trigger) && trigger.get("on") === "run.finished") set(trigger, "pipeline", pipelines);
          const steps = root.get("steps", true);
          if (isSeq(steps))
            for (const step of steps.items)
              if (isMap(step) && step.get("type") === "flow.later") set(step.get("with", true), "pipeline", pipelines);
        }
      }
      if (document.kind === "app" && isMap(root)) {
        const pages = root.get("pages", true);
        if (isSeq(pages)) {
          for (const page of pages.items) {
            const actions = isMap(page) ? page.get("actions", true) : null;
            if (isSeq(actions)) for (const action of actions.items) set(action, "run", pipelines);
          }
        }
      }
    });
  });
}

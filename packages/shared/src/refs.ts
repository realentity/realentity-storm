import { isMap, isScalar, isSeq } from "yaml";
import { editAppSource } from "./app-source";
import { type CompiledDefinition } from "./pipeline";

/**
 * M39-T4: what is shown is the names things have now. A definition keeps the names as they were written when it was
 * saved, and their ids (`refs`); before it goes to the editor, an export or the builder, each name whose thing was
 * renamed since is replaced by its name now. Nothing saved changes until the next save writes the new names.
 */

/** Names now, by id: the user's Apps and saved pipelines. */
export interface CurrentNames {
  apps: Record<string, string>;
  pipelines: Record<string, string>;
}

/** The definition with the names its ids have now; `ownName`: the pipeline's own (its row's, after a migration's " (2)"). */
export function withCurrentNames(definition: CompiledDefinition, names: CurrentNames, ownName?: string): CompiledDefinition {
  const refs = definition.refs;
  const renamed = new Map<string, string>();
  for (const [written, id] of Object.entries(refs?.pipelines ?? {})) {
    const now = names.pipelines[id];
    if (now && now !== written) renamed.set(written, now);
  }
  const app = refs?.appId ? (names.apps[refs.appId] ?? definition.app) : definition.app;
  const trigger =
    typeof definition.trigger === "object" &&
    "on" in definition.trigger &&
    definition.trigger.on === "run.finished" &&
    renamed.has(definition.trigger.pipeline)
      ? { ...definition.trigger, pipeline: renamed.get(definition.trigger.pipeline)! }
      : definition.trigger;
  const steps = definition.steps.map((step) => {
    const target = step.type === "flow.later" ? step.with?.pipeline : undefined;
    return typeof target === "string" && renamed.has(target) ? { ...step, with: { ...step.with, pipeline: renamed.get(target)! } } : step;
  });
  return {
    ...definition,
    name: ownName ?? definition.name,
    ...(app ? { app } : {}),
    trigger,
    steps,
    ...(refs
      ? { refs: { ...refs, pipelines: Object.fromEntries(Object.entries(refs.pipelines).map(([n, id]) => [renamed.get(n) ?? n, id])) } }
      : {}),
  };
}

/** M39-T4: an App's YAML with its buttons' pipelines (`run:`) under their names now; my comments and the rest as written. */
export function withCurrentRuns(
  source: string,
  refs: { pipelines: Record<string, string> } | null | undefined,
  names: CurrentNames,
): string {
  const renamed = new Map<string, string>();
  for (const [written, id] of Object.entries(refs?.pipelines ?? {})) {
    const now = names.pipelines[id];
    if (now && now !== written) renamed.set(written, now);
  }
  if (renamed.size === 0) return source;
  return editAppSource(source, (document) => {
    const pages = document.get("pages", true);
    if (!isSeq(pages)) return;
    for (const page of pages.items) {
      const actions = isMap(page) ? page.get("actions", true) : null;
      if (!isSeq(actions)) continue;
      for (const action of actions.items) {
        if (!isMap(action)) continue;
        const run = action.get("run", true);
        if (isScalar(run) && typeof run.value === "string" && renamed.has(run.value)) run.value = renamed.get(run.value)!;
      }
    }
  });
}

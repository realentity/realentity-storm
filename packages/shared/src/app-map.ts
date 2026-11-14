import { addedByHand, type AppDefinition } from "./app";
import { listPageOf } from "./app-pages";
import { type CompiledDefinition, type Trigger } from "./pipeline";

/**
 * M37-T4: how an App and its pipelines connect, as a map in four columns: what starts the pipelines, the pipelines,
 * the types, the pages. A pipeline writes a type (data.save, a step whose contract writes it) and reads one (data.read,
 * a contract of a type of mine); a type's change starts the pipelines that watch it (entity.changed); a page's button
 * starts one (`run:` of its actions, entity.action).
 */

export type AppMapEdgeKind = "starts" | "writes" | "reads" | "watches" | "shows";

export interface AppMapNode {
  /** trigger:<pipelineId>, pipeline:<pipelineId>, type:<name>, list:<type>, view:<type>. */
  id: string;
  label: string;
  /** A second line: a pipeline's trigger, a type's count. */
  detail?: string;
}

export interface AppMapView {
  triggers: AppMapNode[];
  pipelines: (AppMapNode & { pipelineId: string; enabled: boolean })[];
  types: (AppMapNode & { type: string; entities: number })[];
  pages: (AppMapNode & { type: string; kind: "list" | "view" })[];
  edges: { from: string; to: string; kind: AppMapEdgeKind; label?: string }[];
}

export interface AppMapPipeline {
  pipelineId: string;
  name: string;
  enabled: boolean;
  definition: Pick<CompiledDefinition, "trigger" | "steps">;
}

/** What a step type writes or reads of an App, from its contracts (bill.save writes Bill; price.watch reads Product). */
export type ContractsOf = (stepType: string) => { type: string; mine?: boolean }[];

/** A pipeline's trigger, said as the map says it; null for those drawn as an arrow (an entity's change or button). */
export function triggerLabel(trigger: Trigger): string | null {
  if (trigger === "manual") return "by hand";
  if ("schedule" in trigger) return `on a schedule: ${trigger.schedule}`;
  if ("webhook" in trigger) return "a call from the Internet";
  switch (trigger.on) {
    case "entity.changed":
    case "entity.action":
      return null;
    case "run.finished":
      return `after ${trigger.pipeline}`;
    case "email.classified":
      return trigger.label ? `an email: ${trigger.label.join(", ")}` : "an email";
    case "application.status":
      return "an application's status";
    case "recipe.broken":
      return "a broken recipe";
    case "flow.later":
      return "later, from another pipeline";
    case "view.action":
      return "a button on a pipeline's page";
    case "telegram.command":
      return `/${trigger.command} on Telegram`;
  }
}

export function appMap(
  app: AppDefinition,
  pipelines: AppMapPipeline[],
  entities: Record<string, number>,
  contractsOf: ContractsOf,
): AppMapView {
  const types = Object.keys(app.types);
  const edges: AppMapView["edges"] = [];
  const edge = (from: string, to: string, kind: AppMapEdgeKind, label?: string) => {
    if (!edges.some((e) => e.from === from && e.to === to && e.kind === kind)) edges.push({ from, to, kind, ...(label ? { label } : {}) });
  };
  const triggers: AppMapNode[] = [];
  const byName = new Map(pipelines.map((p) => [p.name, p]));

  for (const pipeline of pipelines) {
    const id = `pipeline:${pipeline.pipelineId}`;
    const trigger = pipeline.definition.trigger;
    const label = triggerLabel(trigger);
    if (label) {
      triggers.push({ id: `trigger:${pipeline.pipelineId}`, label });
      edge(`trigger:${pipeline.pipelineId}`, id, "starts");
    } else if (typeof trigger === "object" && "on" in trigger && trigger.on === "entity.changed") {
      if (types.includes(trigger.type))
        edge(`type:${trigger.type}`, id, "watches", trigger.stage ? `into ${trigger.stage}` : trigger.field);
    }
    for (const step of pipeline.definition.steps) {
      const named = typeof step.with?.type === "string" ? step.with.type : undefined;
      if (named && types.includes(named)) {
        if (step.type === "data.save") edge(id, `type:${named}`, "writes");
        if (step.type === "data.read") edge(`type:${named}`, id, "reads");
      }
      for (const contract of contractsOf(step.type)) {
        if (!types.includes(contract.type)) continue;
        if (contract.mine) edge(`type:${contract.type}`, id, "reads");
        else edge(id, `type:${contract.type}`, "writes");
      }
    }
  }

  // The pages' buttons: a list's start its pipeline by name; an entity's start one triggered by entity.action.
  for (const page of app.pages) {
    if ("list" in page && types.includes(page.list)) {
      for (const action of (page).actions) {
        const pipeline = byName.get(action.run);
        if (pipeline) edge(`list:${page.list}`, `pipeline:${pipeline.pipelineId}`, "starts", action.label);
      }
    }
    if ("view" in page && types.includes(page.view)) {
      for (const action of (page).actions) {
        const pipeline = byName.get(action.run);
        if (pipeline) edge(`view:${page.view}`, `pipeline:${pipeline.pipelineId}`, "starts", action.label);
      }
    }
  }
  for (const pipeline of pipelines) {
    const trigger = pipeline.definition.trigger;
    if (typeof trigger !== "object" || !("on" in trigger) || trigger.on !== "entity.action") continue;
    const id = `pipeline:${pipeline.pipelineId}`;
    if (edges.some((e) => e.to === id && e.from.startsWith("view:"))) continue;
    // A button that names it isn't on a page yet: from the entity's page of its type (or of every type).
    for (const type of trigger.type ? [trigger.type] : types) if (types.includes(type)) edge(`view:${type}`, id, "starts", "a button");
  }

  const pages: AppMapView["pages"] = [];
  for (const type of types) {
    const list = listPageOf(app, type);
    pages.push({ id: `list:${type}`, type, kind: "list", label: list.label, detail: list.menu ? "list, in the menu" : "list" });
    pages.push({ id: `view:${type}`, type, kind: "view", label: `a ${type}`, detail: "its own page" });
    edge(`type:${type}`, `list:${type}`, "shows");
    edge(`type:${type}`, `view:${type}`, "shows");
  }

  return {
    triggers,
    pipelines: pipelines.map((p) => ({
      id: `pipeline:${p.pipelineId}`,
      pipelineId: p.pipelineId,
      label: p.name,
      enabled: p.enabled,
      detail: p.enabled ? undefined : "off",
    })),
    types: types.map((type) => ({
      id: `type:${type}`,
      type,
      label: type,
      entities: entities[type] ?? 0,
      detail: `${entities[type] ?? 0} kept${app.types[type].mine ? " · mine" : addedByHand(app, type) ? " · added by hand too" : ""}`,
    })),
    pages,
    edges,
  };
}

import { useMemo } from "react";
import { parse } from "yaml";

/** An App's types as the trigger card offers them: their fields and stages. */
export interface TriggerTypes {
  [type: string]: { fields: string[]; states: string[] };
}

/** A pipeline as the cards read it: loosely, so they show what is there while it has problems. */
export interface LoosePipeline {
  name: string;
  app: string;
  description: string;
  trigger: unknown;
  steps: LooseStep[];
}
export interface LooseStep {
  id: string;
  type: string;
  when?: string;
  forEach?: string;
  retries?: number;
  with: Record<string, unknown>;
}

export function loosePipeline(source: string): LoosePipeline | null {
  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    name: str(root.name),
    app: str(root.app),
    description: str(root.description),
    trigger: root.trigger,
    steps: (Array.isArray(root.steps) ? root.steps : []).map((raw) => {
      const step = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const withValue =
        step.with && typeof step.with === "object" && !Array.isArray(step.with) ? (step.with as Record<string, unknown>) : {};
      return {
        id: str(step.id),
        type: str(step.type),
        when: typeof step.when === "string" ? step.when : undefined,
        forEach: typeof step.forEach === "string" ? step.forEach : undefined,
        retries: typeof step.retries === "number" ? step.retries : undefined,
        with: withValue,
      };
    }),
  };
}

/** Where a compile problem is: the trigger, a step (and its input), or the pipeline. */
export function issuePlace(path: string): { step?: number; input?: string; trigger?: boolean } {
  if (path === "trigger" || path.startsWith("trigger.") || path.startsWith("trigger[")) return { trigger: true };
  const match = /^steps\[(\d+)\](?:\.with\.([^.[]+))?/.exec(path);
  return match ? { step: Number(match[1]), input: match[2] } : {};
}

/** The App's types as the trigger and the picker use them, from its definition. */
export function useTriggerTypes(
  definition: { types: Record<string, { fields: Record<string, unknown>; stages?: { states: string[] } }> } | null,
): TriggerTypes {
  return useMemo(() => {
    if (!definition) return {};
    return Object.fromEntries(
      Object.entries(definition.types).map(([name, type]) => [
        name,
        { fields: Object.keys(type.fields), states: type.stages?.states ?? [] },
      ]),
    );
  }, [definition]);
}

import { parse } from "yaml";

/** The App as the YAML says, read loosely: the tabs show what is there even while it has problems. */
export interface LooseApp {
  name?: string;
  types: [string, LooseType][];
  pages: Record<string, unknown>[];
}
export interface LooseType {
  key?: unknown;
  title?: unknown;
  mine?: unknown;
  description?: unknown;
  fields: [string, Record<string, unknown>][];
  stages?: { field?: unknown; initial?: unknown; states: string[]; moves: { from: string[]; to: string[]; by: string[] }[] };
}

export function loose(source: string): LooseApp {
  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch {
    parsed = null;
  }
  const root = asObject(parsed);
  return {
    name: typeof root.name === "string" ? root.name : undefined,
    types: Object.entries(asObject(root.types)).map(([name, raw]) => {
      const type = asObject(raw);
      const stages = asObject(type.stages);
      return [
        name,
        {
          key: type.key,
          title: type.title,
          mine: type.mine,
          description: type.description,
          fields: Object.entries(asObject(type.fields)).map(([field, def]) => [field, asObject(def)]),
          stages: type.stages
            ? {
                field: stages.field,
                initial: stages.initial,
                states: asStrings(stages.states),
                moves: (Array.isArray(stages.moves) ? stages.moves : []).map((m) => {
                  const move = asObject(m);
                  return { from: asStrings(move.from), to: asStrings(move.to), by: move.by === undefined ? ["me"] : asStrings(move.by) };
                }),
              }
            : undefined,
        },
      ];
    }),
    pages: (Array.isArray(root.pages) ? root.pages : []).map(asObject),
  };
}

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asStrings(value: unknown): string[] {
  return (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]).map(String);
}

export function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return value === undefined || value === null ? "" : JSON.stringify(value);
}

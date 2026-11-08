import { loose } from "./loose-app";
import { loosePipeline } from "./step-cards";

/**
 * M38-T5: what a builder's proposal changes in what the editor had open: marked where it is (a step's card, a type's
 * table, a field's row), and listed, until the user clears the marks or Undo.
 */
export interface BuilderMarks {
  /** Pipeline: step ids and "trigger". App: type names and "Type.field". */
  marked: Set<string>;
  /** In words, for the banner: "search changed", "Bill.amount added". */
  changes: string[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function pipelineMarks(before: string, after: string): BuilderMarks {
  const old = loosePipeline(before);
  const next = loosePipeline(after);
  const marked = new Set<string>();
  const changes: string[] = [];
  if (!next) return { marked, changes };
  if (!same(old?.trigger, next.trigger)) {
    marked.add("trigger");
    changes.push("its trigger changed");
  }
  const oldSteps = new Map((old?.steps ?? []).map((s) => [s.id, s]));
  for (const step of next.steps) {
    const was = oldSteps.get(step.id);
    if (!was) changes.push(`${step.id} added`);
    else if (!same(was, step)) changes.push(`${step.id} changed`);
    else continue;
    marked.add(step.id);
  }
  for (const id of oldSteps.keys()) if (!next.steps.some((s) => s.id === id)) changes.push(`${id} removed`);
  for (const property of ["name", "app", "description"] as const) {
    if (old && !same(old[property], next[property])) changes.push(`its ${property} changed`);
  }
  return { marked, changes };
}

export function appMarks(before: string, after: string): BuilderMarks {
  const old = loose(before);
  const next = loose(after);
  const marked = new Set<string>();
  const changes: string[] = [];
  const oldTypes = new Map(old.types);
  for (const [name, type] of next.types) {
    const was = oldTypes.get(name);
    if (!was) {
      marked.add(name);
      changes.push(`${name} added`);
      continue;
    }
    const { fields, stages, ...rest } = type;
    const { fields: oldFields, stages: oldStages, ...oldRest } = was;
    if (!same(rest, oldRest)) {
      marked.add(name);
      changes.push(`${name} changed`);
    }
    if (!same(stages, oldStages)) {
      marked.add(name);
      changes.push(`${name}'s stages changed`);
    }
    const oldByName = new Map(oldFields);
    for (const [field, def] of fields) {
      const wasField = oldByName.get(field);
      if (wasField && same(wasField, def)) continue;
      marked.add(`${name}.${field}`);
      changes.push(`${name}.${field} ${wasField ? "changed" : "added"}`);
    }
    for (const [field] of oldFields) if (!fields.some(([f]) => f === field)) changes.push(`${name}.${field} removed`);
  }
  for (const [name] of old.types) if (!next.types.some(([n]) => n === name)) changes.push(`${name} removed`);
  if (!same(old.pages, next.pages)) changes.push("its pages changed");
  if (old.name !== next.name) changes.push("its name changed");
  return { marked, changes };
}

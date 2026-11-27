import {
  addedByHand,
  FIELD_KINDS,
  FILTER_CONTROLS,
  pageKind,
  READ_CONTROLS,
  reportPagesOf,
  TRIGGER_EVENTS,
  type AppDefinition,
  type CompiledDefinition,
} from "@realentity/storm-shared";
import { type StepCatalog } from "./catalog";

/**
 * M67-T1 (M7-V1's, grown to Apps): what makes what the builder proposed equivalent to a hand-written example, for the
 * builder's eval. What matters, not the wording: names of steps, instructions, labels and literal text may differ.
 */

/** An App with its pipelines, each compiled against it. */
export interface AppWithPipelines {
  app: AppDefinition;
  pipelines: CompiledDefinition[];
}

/** Fields of a side effect's input whose references are compared, beyond its catalog targets. */
const SOURCE_FIELDS = ["to", "message", "subject", "body", "inReplyTo", "items", "text"];

/**
 * Two pipelines are equivalent when they have the same trigger, the same step types in order (gates included), each
 * step iterating over the same thing, each side effect's inputs coming from the same steps (by type, so ids may
 * differ; literal text may differ), at least the example's limits (more is a stricter cap), and as many slots
 * (credentials, settings) used.
 */
export function pipelineDifferences(expected: CompiledDefinition, actual: CompiledDefinition, catalog: StepCatalog): string[] {
  const problems: string[] = [];
  const same = (what: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${what}: expected ${JSON.stringify(a)}, got ${JSON.stringify(b)}`);
  };
  same("trigger", expected.trigger, actual.trigger);
  same("steps", expected.steps.map((s) => s.type), actual.steps.map((s) => s.type));
  const [e, a] = [shape(expected, catalog), shape(actual, catalog)];
  same("forEach", e.forEach, a.forEach);
  same("side effects' sources", e.sources, a.sources);
  same("slots", e.slots, a.slots);
  // Every limit the example has, as it has it; one more is a stricter cap, which is fine.
  const limits = expected.limits ?? {};
  const kept = Object.fromEntries(Object.keys(limits).map((k) => [k, actual.limits?.[k] ?? null]));
  same("limits", limits, kept);
  return problems;
}

/**
 * Two Apps are equivalent when they have the same types, each with a key of the same kind, the same `mine` and as many
 * fields of mine of each kind, the same stages (states, initial and moves; the stage field may be named otherwise) and
 * whether it is added by hand; the same reports, slots (by kind) and uses; and
 * pipelines that pair up, each equivalent to its pair. Fields other than those, pages' layout and wording may differ.
 */
export function appDifferences(expected: AppWithPipelines, actual: AppWithPipelines, catalog: StepCatalog): string[] {
  const problems: string[] = [];
  const same = (what: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${what}: expected ${JSON.stringify(a)}, got ${JSON.stringify(b)}`);
  };
  const [e, a] = [expected.app, actual.app];
  same("types", Object.keys(e.types).sort(), Object.keys(a.types).sort());
  for (const name of Object.keys(e.types).filter((t) => Object.hasOwn(a.types, t))) same(name, typeShape(e, name), typeShape(a, name));
  same("reports", reportPagesOf(e).map((r) => r.type).sort(), reportPagesOf(a).map((r) => r.type).sort());
  same("slots", slotsOf(e), slotsOf(a));
  same("uses", usesOf(e), usesOf(a));
  same("pipelines", expected.pipelines.length, actual.pipelines.length);
  for (const [want, got] of pair(expected.pipelines, actual.pipelines, catalog)) {
    if (!got) problems.push(`pipeline "${want.name}": none like it`);
    else problems.push(...pipelineDifferences(want, got, catalog).map((p) => `pipeline "${want.name}": ${p}`));
  }
  return problems;
}

/** Each expected pipeline with the proposed one most like it (fewest differences), each proposed one used once. */
function pair(expected: CompiledDefinition[], actual: CompiledDefinition[], catalog: StepCatalog): [CompiledDefinition, CompiledDefinition | null][] {
  const left = [...actual];
  return expected.map((want) => {
    const scored = left.map((got) => ({ got, score: pipelineDifferences(want, got, catalog).length }));
    const best = scored.sort((x, y) => x.score - y.score)[0];
    if (!best) return [want, null];
    left.splice(left.indexOf(best.got), 1);
    return [want, best.got];
  });
}

function typeShape(app: AppDefinition, name: string) {
  const type = app.types[name];
  const kindOf = (field: string) => type.fields[field]?.type ?? "stage";
  const stages = type.stages
    ? {
        initial: type.stages.initial,
        states: [...type.stages.states].sort(),
        moves: type.stages.moves
          .flatMap((m) => (Array.isArray(m.from) ? m.from : [m.from]).flatMap((from) => m.to.map((to) => `${from}→${to} by ${[...m.by].sort().join("+")}`)))
          .sort(),
      }
    : null;
  return {
    key: kindOf(type.key),
    mine: type.mine,
    fieldsOfMine: Object.entries(type.fields)
      .filter(([, f]) => f.mine)
      .map(([, f]) => f.type)
      .sort(),
    stages,
    addedByHand: addedByHand(app, name),
  };
}

/** Credential and text slots by kind; an email or Google account slot is the instance's default account otherwise, so either is fine. */
function slotsOf(app: AppDefinition): string[] {
  return Object.values(app.needs ?? {})
    .filter((need) => need.kind === "credential" || need.kind === "text")
    .map((need) => (need.kind === "credential" && need.type ? `credential:${need.type}` : need.kind))
    .sort();
}

function usesOf(app: AppDefinition): string[] {
  return Object.entries(app.uses ?? {})
    .map(([name, use]) => `${name} ← ${use.from.app} › ${use.from.type}`)
    .sort();
}

/** forEach sources, side effects' references with step ids as step types, and how many of each slot kind are used. */
function shape(definition: CompiledDefinition, catalog: StepCatalog) {
  const typeOf = new Map(definition.steps.map((s) => [s.id, s.type]));
  const refs = (value: unknown): string[] =>
    [...JSON.stringify(value ?? null).matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map(([, ref]) => ref.replace(/^([a-zA-Z0-9_]+)/, (id: string) => typeOf.get(id) ?? id));
  const slots: Record<string, number> = {};
  for (const step of definition.steps)
    for (const ref of refs(step.with)) {
      const kind = /^(cred|setting):/.exec(ref)?.[1];
      if (kind) slots[kind] = (slots[kind] ?? 0) + 1;
    }
  const sources = definition.steps
    .filter((s) => catalog.get(s.type)?.sideEffect || s.type === "email.draftReply")
    .map((s) => {
      const fields = [...new Set([...Object.keys(catalog.get(s.type)?.targets ?? {}), ...SOURCE_FIELDS])].filter((f) => s.with[f] !== undefined).sort();
      return Object.fromEntries(fields.map((f) => [f, refs(s.with[f])]));
    });
  return { forEach: definition.steps.map((s) => (s.forEach ? refs(s.forEach) : null)), sources, slots };
}

/**
 * M67-T4: every capability an App or pipeline can use, by id: each catalog step (`step:email.send`), trigger
 * (`trigger:schedule`, `trigger:entity.changed`), field kind (`field:money`), page (`page:report`) and control
 * (`control:calendar`). The builder's cases should use each one at least once.
 */
export function capabilities(catalog: StepCatalog): string[] {
  return [
    ...catalog.list().map((s) => `step:${s.type}`),
    ...["manual", "schedule", "webhook", ...TRIGGER_EVENTS].map((t) => `trigger:${t}`),
    ...FIELD_KINDS.map((k) => `field:${k}`),
    ...["list", "view", "form", "report"].map((p) => `page:${p}`),
    ...[...new Set([...READ_CONTROLS, ...FILTER_CONTROLS])].map((c) => `control:${c}`),
  ];
}

/** M67-T4: the capabilities an App and its pipelines use (see `capabilities`). */
export function capabilitiesUsed(app: AppDefinition | null, pipelines: CompiledDefinition[]): Set<string> {
  const used = new Set<string>();
  for (const pipeline of pipelines) {
    for (const step of pipeline.steps) used.add(`step:${step.type}`);
    const trigger = pipeline.trigger;
    used.add(`trigger:${trigger === "manual" ? "manual" : "schedule" in trigger ? "schedule" : "webhook" in trigger ? "webhook" : trigger.on}`);
  }
  for (const type of Object.values(app?.types ?? {})) for (const field of Object.values(type.fields)) used.add(`field:${field.type}`);
  for (const page of app?.pages ?? []) {
    used.add(`page:${pageKind(page)[0]}`);
    if ("list" in page) for (const c of [...(page.controls ?? []), ...(page.columns ?? []).filter((c) => typeof c !== "string")]) if (c.control) used.add(`control:${c.control}`);
  }
  return used;
}

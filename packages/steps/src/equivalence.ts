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
import { rawReferencesIn } from "./compiler";

/**
 * M67-T1 (M7-V1's, grown to Apps): what makes what the builder proposed equivalent to a hand-written example, for the
 * builder's eval. What matters, not the wording: names of steps, instructions, labels and literal text may differ.
 */

/** An App with its pipelines, each compiled against it. */
export interface AppWithPipelines {
  app: AppDefinition;
  pipelines: CompiledDefinition[];
}

/**
 * Steps that only shape what other steps give (map, filter, dedupe, history, alert), or write text a template could
 * write as well (llm.generate): which of them, how many and in what order may differ.
 */
const SHAPING = new Set(["data.map", "data.filter", "data.dedupe", "data.history", "data.alert", "llm.generate"]);
/** Steps that only tell me or only read: one more is fine (telling me more, or reading more, is no other design). */
const ONE_MORE_IS_FINE = new Set(["notify.telegram", "notify.digest", "data.read"]);
/** Fields of a side effect's input that say where it goes, beyond its catalog targets (in a thread or not is no other place). */
const WHERE_FIELDS = ["to", "url", "attendees"];

/** Each pipeline's App, when it has one: a trigger's field is compared by its kind, since field names may differ. */
export interface PipelineApps {
  expected?: AppDefinition | null;
  actual?: AppDefinition | null;
}

/**
 * Two pipelines are equivalent when they start the same way (a trigger's kind and what it points at; not its help
 * text, and a field by its kind), use the same kinds of steps (the ones that only shape data may differ, in which and
 * how many; the order may differ; one more that tells me or reads is fine), have the same side effects, each going once or per
 * item and to the same kind of place (an item, the trigger, a setting, another step's output: not which field of it),
 * at least the example's limits (more is a stricter cap), and as many slots (credentials, settings) used.
 */
export function pipelineDifferences(expected: CompiledDefinition, actual: CompiledDefinition, catalog: StepCatalog, apps: PipelineApps = {}): string[] {
  const problems: string[] = [];
  const same = (what: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${what}: expected ${JSON.stringify(a)}, got ${JSON.stringify(b)}`);
  };
  same("trigger", triggerShape(expected, apps.expected), triggerShape(actual, apps.actual));
  const kinds = (d: CompiledDefinition) => [...new Set(d.steps.map((s) => s.type).filter((t) => !SHAPING.has(t)))].sort();
  const [wanted, used] = [kinds(expected), kinds(actual)];
  const missing = wanted.filter((t) => !used.includes(t));
  const extra = used.filter((t) => !wanted.includes(t) && !ONE_MORE_IS_FINE.has(t));
  if (missing.length > 0 || extra.length > 0) problems.push(`steps: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(used)}`);
  const [e, a] = [shape(expected, catalog), shape(actual, catalog)];
  same("side effects", e.sideEffects, a.sideEffects);
  // Credentials as the example uses them; its settings at least (one more lets me set what it hard-codes).
  same("credentials", e.slots.cred ?? 0, a.slots.cred ?? 0);
  if ((a.slots.setting ?? 0) < (e.slots.setting ?? 0)) problems.push(`settings: expected at least ${e.slots.setting}, got ${a.slots.setting ?? 0}`);
  // Every limit the example has, as it has it; one more is a stricter cap, which is fine.
  const limits = expected.limits ?? {};
  const kept = Object.fromEntries(Object.keys(limits).map((k) => [k, actual.limits?.[k] ?? null]));
  same("limits", limits, kept);
  return problems;
}

/**
 * Two Apps are equivalent when they have the same types, each with a key of the same kind, the same `mine`, at least
 * its fields of mine of each kind, the same stages (states and initial; the stage field may be named otherwise), at
 * least the moves its pipelines make (the ones I make are mine to allow, and staying put is no move), and whether it is
 * added by hand; the same reports, credential slots and uses, at least its text settings; and pipelines that pair up,
 * each equivalent to its pair. Fields other than those, pages' layout and wording may differ.
 */
export function appDifferences(expected: AppWithPipelines, actual: AppWithPipelines, catalog: StepCatalog): string[] {
  const problems: string[] = [];
  const same = (what: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${what}: expected ${JSON.stringify(a)}, got ${JSON.stringify(b)}`);
  };
  const [e, a] = [expected.app, actual.app];
  same("types", Object.keys(e.types).sort(), Object.keys(a.types).sort());
  for (const name of Object.keys(e.types).filter((t) => Object.hasOwn(a.types, t))) {
    const [want, got] = [typeShape(e, name), typeShape(a, name)];
    same(name, { ...want, fieldsOfMine: null, pipelineMoves: null }, { ...got, fieldsOfMine: null, pipelineMoves: null });
    const short = (what: string, of: string[], from: string[]) => {
      const missing = without(of, from);
      if (missing.length > 0) problems.push(`${name}: ${what} missing: ${JSON.stringify(missing)}`);
    };
    short("fields of mine", want.fieldsOfMine, got.fieldsOfMine);
    short("moves by a pipeline", want.pipelineMoves, got.pipelineMoves);
  }
  same("reports", reportPagesOf(e).map((r) => r.type).sort(), reportPagesOf(a).map((r) => r.type).sort());
  // Credential slots as the example has them; its text settings at least (one more lets me set what it hard-codes).
  same("credential slots", slotsOf(e, "credential"), slotsOf(a, "credential"));
  const texts = slotsOf(e, "text").length;
  if (slotsOf(a, "text").length < texts) problems.push(`text settings: expected at least ${texts}, got ${slotsOf(a, "text").length}`);
  same("uses", usesOf(e), usesOf(a));
  same("pipelines", expected.pipelines.length, actual.pipelines.length);
  const apps = { expected: e, actual: a };
  for (const [want, got] of pair(expected.pipelines, actual.pipelines, catalog, apps)) {
    if (!got) problems.push(`pipeline "${want.name}": none like it`);
    else problems.push(...pipelineDifferences(want, got, catalog, apps).map((p) => `pipeline "${want.name}": ${p}`));
  }
  return problems;
}

/** The items of `of` that `from` lacks, counting each (two longtexts need two). */
function without(of: string[], from: string[]): string[] {
  const left = [...from];
  return of.filter((item) => {
    const i = left.indexOf(item);
    if (i >= 0) left.splice(i, 1);
    return i < 0;
  });
}

/** Each expected pipeline with the proposed one most like it (fewest differences), each proposed one used once. */
function pair(expected: CompiledDefinition[], actual: CompiledDefinition[], catalog: StepCatalog, apps: PipelineApps): [CompiledDefinition, CompiledDefinition | null][] {
  const left = [...actual];
  return expected.map((want) => {
    const scored = left.map((got) => ({ got, score: pipelineDifferences(want, got, catalog, apps).length }));
    const best = scored.sort((x, y) => x.score - y.score)[0];
    if (!best) return [want, null];
    left.splice(left.indexOf(best.got), 1);
    return [want, best.got];
  });
}

function typeShape(app: AppDefinition, name: string) {
  const type = app.types[name];
  const kindOf = (field: string) => type.fields[field]?.type ?? "stage";
  const stages = type.stages ? { initial: type.stages.initial, states: [...type.stages.states].sort() } : null;
  const pipelineMoves = (type.stages?.moves ?? [])
    .filter((m) => m.by.includes("pipeline"))
    .flatMap((m) => (Array.isArray(m.from) ? m.from : [m.from]).flatMap((from) => m.to.filter((to) => to !== from).map((to) => `${from}→${to}`)));
  return {
    key: kindOf(type.key),
    mine: type.mine,
    fieldsOfMine: Object.entries(type.fields)
      .filter(([, f]) => f.mine)
      .map(([, f]) => f.type)
      .sort(),
    stages,
    pipelineMoves: [...new Set(pipelineMoves)].sort(),
    addedByHand: addedByHand(app, name),
  };
}

/** Its slots of a kind (a credential by its type); an email or Google account slot is the default account otherwise, so either is fine. */
function slotsOf(app: AppDefinition, kind: "credential" | "text"): string[] {
  return Object.values(app.needs ?? {})
    .filter((need) => need.kind === kind)
    .map((need) => (need.kind === "credential" && need.type ? `credential:${need.type}` : need.kind))
    .sort();
}

function usesOf(app: AppDefinition): string[] {
  return Object.entries(app.uses ?? {})
    .map(([name, use]) => `${name} ← ${use.from.app} › ${use.from.type}`)
    .sort();
}

/** A pipeline's name without its App's ("Releases · Watch" is "Watch"): an App's pipelines may be named either way. */
const shortName = (name: string) => name.replace(/^.+? · /, "");

/** A trigger's kind and what it points at: not a command's help text; a field by its kind; another pipeline by its short name. */
function triggerShape(definition: CompiledDefinition, app: AppDefinition | null | undefined): unknown {
  const trigger = definition.trigger;
  if (trigger === "manual" || !("on" in trigger)) return trigger;
  const { description: _, ...shown } = trigger as typeof trigger & { description?: string };
  if (shown.on === "run.finished") return { ...shown, pipeline: shortName(shown.pipeline) };
  if (shown.on === "entity.changed" && shown.field) {
    const type = app?.types[shown.type];
    const kind = type?.stages?.field === shown.field ? "stage" : type?.fields[shown.field]?.type;
    return { ...shown, field: kind ? `a ${kind} field` : shown.field };
  }
  return shown;
}

/**
 * Its side effects, each as its type, whether it goes once or per item, and where it goes: the roots of what its
 * targets read (an item, the trigger, a setting, another step by its type); and how many of each slot kind are used.
 */
function shape(definition: CompiledDefinition, catalog: StepCatalog) {
  const typeOf = new Map(definition.steps.map((s) => [s.id, s.type]));
  const refs = (value: unknown): string[] => rawReferencesIn(value);
  const root = (ref: string) => {
    const slot = /^(cred|setting):/.exec(ref)?.[1];
    const head = /^\w+/.exec(ref)?.[0] ?? ref;
    return slot ?? typeOf.get(head) ?? head;
  };
  const slots: Record<string, number> = {};
  for (const step of definition.steps)
    for (const ref of refs(step.with)) {
      const kind = /^(cred|setting):/.exec(ref)?.[1];
      if (kind) slots[kind] = (slots[kind] ?? 0) + 1;
    }
  const sideEffects = definition.steps
    .filter((s) => catalog.get(s.type)?.sideEffect)
    .map((s) => {
      const fields = [...new Set([...Object.keys(catalog.get(s.type)?.targets ?? {}), ...WHERE_FIELDS])].filter((f) => s.with[f] !== undefined).sort();
      const where = fields.map((f) => `${f} from ${[...new Set(refs(s.with[f]).map(root))].sort().join("+") || "text"}`);
      return `${s.type} ${s.forEach ? "per item" : "once"}${where.length > 0 ? `, ${where.join(", ")}` : ""}`;
    })
    .sort();
  return { sideEffects, slots };
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

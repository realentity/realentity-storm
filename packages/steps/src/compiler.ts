import {
  type AppDefinition,
  addedByHand,
  FILE_KINDS,
  PipelineDefinitionSchema,
  REFERENCE,
  WHOLE_REFERENCE,
  type CompiledDefinition,
  type CompiledPolicy,
  type CompiledStep,
  type CompileIssue,
  type CompileResult,
  type PipelineDefinition,
  type PipelineStep,
  type ProvenanceRule,
  type TargetKind,
  type Trigger,
  hostMatches,
  isEventTrigger,
  isWebhookTrigger,
} from "@realentity/storm-shared";
import { parse as parseYaml } from "yaml";
import { type z } from "zod";
import { defaultCatalog, type EntityContract, type StepCatalog, type StepDefinition } from "./catalog";
import { triggerDataSchema, triggerTargetIssue } from "./triggers";
import { contractProblems } from "./domain-entities";
import { entityTypeInfo, entityTypeOf } from "./entity-types";
import { describeSchema, formatType, isAssignable, isOptional, navigate, UNKNOWN, type TypeInfo } from "./type-info";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface CompiledStepInfo {
  definition: StepDefinition;
  /** The forEach source path ("search.items"), when the step fans out. */
  forEach?: string;
  /** Its output typed by more than the catalog knows: data.read's items by their App type (M30). */
  output?: TypeInfo;
  /** data.read of a type pipelines write (M32): its items are what pages, feeds and emails said, never a target. */
  untrusted?: string;
}

/** What a pipeline is compiled against besides the catalog: its App's current version (M30), found by the caller. */
export interface CompileContext {
  app?: AppDefinition;
}

interface Scope {
  step: PipelineStep;
  definition: StepDefinition;
  path: string;
  forEach?: string;
  itemType?: TypeInfo;
  /** The pipeline's trigger: {{trigger.*}} has its event's data. */
  trigger: Trigger;
  app?: AppDefinition;
}

type Resolution = { ok: true; type: TypeInfo; credential?: boolean } | { ok: false; message: string };

/**
 * Compiles a pipeline definition (docs/design.md §2.1–2.2): validates its structure and every step against the catalog,
 * checks {{references}} and their types, inserts the gates side-effect steps need, and derives the policy
 * (what side-effect steps may target). The runner only ever executes what this produced.
 */
export class PipelineCompiler {
  constructor(private readonly catalog: StepCatalog = defaultCatalog()) {}

  /** From YAML (or JSON, which is YAML). */
  compileText(text: string, context: CompileContext = {}): CompileResult {
    let parsed: unknown;
    try {
      parsed = parseYaml(text);
    } catch (error) {
      return { ok: false, errors: [{ path: "", message: `Not valid YAML: ${error instanceof Error ? error.message : String(error)}` }] };
    }
    return this.compile(parsed, context);
  }

  compile(input: unknown, context: CompileContext = {}): CompileResult {
    const structure = PipelineDefinitionSchema.safeParse(input);
    if (!structure.success) {
      return { ok: false, errors: structure.error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message })) };
    }
    const definition = structure.data;
    const errors: CompileIssue[] = [];
    const warnings: CompileIssue[] = [];
    const known = new Map<string, CompiledStepInfo>();
    const ids = new Set<string>();
    const policy: CompiledPolicy = {
      allowedDomains: [...definition.policy.allowedDomains],
      allowedRecipients: [...definition.policy.allowedRecipients],
      provenance: [],
    };
    const app = definition.app && context.app?.name === definition.app ? context.app : undefined;
    if (definition.app && !app) errors.push({ path: "app", message: `there is no App named "${definition.app}"` });
    checkAppTrigger(definition.trigger, app, Boolean(definition.app), errors);

    definition.steps.forEach((step, index) => {
      const path = `steps[${index}]`;
      if (ids.has(step.id)) errors.push({ path: `${path}.id`, message: `"${step.id}" is used by an earlier step` });
      ids.add(step.id);

      const stepDefinition = this.catalog.get(step.type);
      if (!stepDefinition) {
        errors.push({ path: `${path}.type`, message: `unknown step type "${step.type}"` });
        return;
      }

      const scope: Scope = { step, definition: stepDefinition, path, trigger: definition.trigger, app };
      if (step.forEach) {
        const source = referencePath(step.forEach);
        const resolved = this.resolve(source, { ...scope }, known);
        if (!resolved.ok) {
          errors.push({ path: `${path}.forEach`, message: resolved.message });
        } else if (resolved.type.kind !== "array" && resolved.type.kind !== "unknown") {
          errors.push({ path: `${path}.forEach`, message: `{{${source}}} is a ${formatType(resolved.type)}, not a list` });
        } else {
          scope.forEach = source;
          scope.itemType = resolved.type.kind === "array" ? resolved.type.element : UNKNOWN;
        }
      }

      if (step.when) {
        const resolved = this.resolve(referencePath(step.when), scope, known);
        if (!resolved.ok) errors.push({ path: `${path}.when`, message: resolved.message });
      }

      for (const field of stepDefinition.reads ?? []) {
        for (const [at, url] of literalUrls(step.with[field])) {
          const host = /^https?:\/\/([^/{}?#:]+)/i.exec(url)?.[1]?.toLowerCase();
          if (host && !definition.policy.allowedDomains.some((allowed) => hostMatches(host, [allowed]))) {
            errors.push({ path: `${path}.with.${field}${at}`, message: `${host} isn't in policy.allowedDomains: add it there to read from it` });
          }
        }
      }

      if (stepDefinition.sideEffect && step.retries) {
        errors.push({ path: `${path}.retries`, message: "side-effect steps are never retried automatically" });
      }

      this.checkInputs(scope, known, errors);
      const entities = this.checkEntitySteps(scope, Boolean(definition.app), known, errors);
      for (const contract of stepDefinition.entities ?? []) checkContract(stepDefinition, contract, definition.app, app, path, errors);
      if (stepDefinition.sideEffect) this.collectTargets(scope, known, policy, errors);
      known.set(step.id, { definition: stepDefinition, forEach: scope.forEach, ...entities });
    });

    for (const [type] of Object.entries(definition.limits)) {
      const limited = this.catalog.get(type);
      if (!limited) errors.push({ path: `limits.${type}`, message: `unknown step type "${type}"` });
      // The runner applies limits before a side effect executes (docs/design.md §2.2); elsewhere they would do nothing.
      else if (!limited.sideEffect) errors.push({ path: `limits.${type}`, message: "only side-effect steps have rate limits" });
    }

    if (definition.view) checkView(definition, errors);

    const steps = errors.length === 0 ? this.placeGates(definition.steps, known, errors, warnings) : [];
    if (errors.length > 0) return { ok: false, errors };

    policy.allowedDomains = unique(policy.allowedDomains);
    policy.allowedRecipients = unique(policy.allowedRecipients);
    const compiled: CompiledDefinition = { ...definition, steps };
    return { ok: true, definition: compiled, policy, warnings };
  }

  /** Every input field: known, present when required, references valid and type-compatible, literals valid. */
  private checkInputs(scope: Scope, known: Map<string, CompiledStepInfo>, errors: CompileIssue[]): void {
    const shape = scope.definition.input.shape as Record<string, z.ZodType>;
    const provided = scope.step.with;

    for (const key of Object.keys(provided)) {
      if (!(key in shape)) {
        errors.push({
          path: `${scope.path}.with.${key}`,
          message: `unknown parameter for ${scope.step.type} (parameters: ${Object.keys(shape).join(", ")})`,
        });
      }
    }

    for (const [key, fieldSchema] of Object.entries(shape)) {
      const fieldPath = `${scope.path}.with.${key}`;
      if (!(key in provided)) {
        if (!isOptional(fieldSchema)) errors.push({ path: fieldPath, message: "is required" });
        continue;
      }
      const value = provided[key];

      let hasReferences = false;
      let credentialUsed = false;
      for (const reference of referencesIn(value)) {
        hasReferences = true;
        const resolved = this.resolve(reference, scope, known);
        if (!resolved.ok) errors.push({ path: fieldPath, message: resolved.message });
        else if (resolved.credential) credentialUsed = true;
      }
      const accepts = scope.definition.acceptsCredentials;
      if (credentialUsed && (!accepts || (Array.isArray(accepts) && !accepts.includes(key)))) {
        errors.push({
          path: fieldPath,
          message: Array.isArray(accepts)
            ? `${scope.step.type} takes credentials ({{cred:…}}) only in ${accepts.join(" and ")}`
            : `${scope.step.type} can't receive credentials ({{cred:…}}); they never reach the LLM or notifications`,
        });
      }

      const whole = typeof value === "string" ? WHOLE_REFERENCE.exec(value) : null;
      if (whole?.[1]) {
        const resolved = this.resolve(whole[1].trim(), scope, known);
        const expected = describeSchema(fieldSchema);
        if (resolved.ok && !isAssignable(resolved.type, expected)) {
          errors.push({
            path: fieldPath,
            message: `expects ${formatType(expected)} but {{${whole[1].trim()}}} is ${formatType(resolved.type)}`,
          });
        }
      } else if (!hasReferences) {
        const literal = fieldSchema.safeParse(value);
        if (!literal.success) {
          for (const issue of literal.error.issues)
            errors.push({ path: `${fieldPath}${issue.path.length ? `.${formatPath(issue.path)}` : ""}`, message: issue.message });
        }
      } else if (
        typeof value === "string" &&
        describeSchema(fieldSchema).kind !== "string" &&
        describeSchema(fieldSchema).kind !== "unknown"
      ) {
        errors.push({ path: fieldPath, message: `expects ${formatType(describeSchema(fieldSchema))}; text with references is a string` });
      }
      // Values with references nested deeper are validated by the runner against the schema once resolved.
    }
  }

  /**
   * data.save with `type` and data.read (M30): the type is one of the App's, and the fields they name are its fields;
   * a pipeline never writes a field of mine. data.read's items are typed by the type, so {{item.salery}} is a mistake.
   */
  private checkEntitySteps(
    scope: Scope,
    inApp: boolean,
    known: Map<string, CompiledStepInfo>,
    errors: CompileIssue[],
  ): Pick<CompiledStepInfo, "output" | "untrusted"> {
    const { step, path } = scope;
    if (step.type === "file.keep") {
      this.checkFileKeep(scope, inApp, errors);
      return {};
    }
    if (step.type !== "data.save" && step.type !== "data.read" && step.type !== "data.dedupe") return {};
    const typeName = step.type === "data.dedupe" ? step.with.againstType : step.with.type;
    if (typeof typeName !== "string") return {};
    const at = `${path}.with`;
    if (!inApp) {
      errors.push({ path: `${at}.type`, message: "entity types belong to an App: say which with `app:` at the top of the pipeline" });
      return {};
    }
    if (!scope.app) return {}; // the missing App is already said
    const type = entityTypeOf(scope.app, typeName);
    if (!type) {
      errors.push({ path: `${at}.type`, message: `"${scope.app.name}" has no type "${typeName}" (types: ${Object.keys(scope.app.types).join(", ")})` });
      return {};
    }
    const fieldIssue = (field: unknown, where: string, extra: string[] = []) => {
      if (typeof field === "string" && referencesIn(field).length > 0) {
        errors.push({ path: where, message: "names a field of the type as it is, not through a reference" });
        return;
      }
      if (typeof field !== "string" || extra.includes(field) || field in type.fields) return;
      errors.push({ path: where, message: `${typeName} has no field "${field}" (fields: ${Object.keys(type.fields).join(", ")})` });
    };

    if (step.type === "data.dedupe") return {};
    if (step.type === "data.save") {
      const stage = step.with.stage;
      if (typeof stage === "string" && referencesIn(stage).length === 0) {
        if (!type.stages) errors.push({ path: `${at}.stage`, message: `${typeName} has no stages` });
        else if (!type.stages.states.includes(stage)) {
          errors.push({ path: `${at}.stage`, message: `"${stage}" is not a state of ${typeName} (states: ${type.stages.states.join(", ")})` });
        }
      }
      if (type.mine) {
        errors.push({ path: `${at}.type`, message: `${typeName} is a type of mine: pipelines read it, only the user writes it` });
        return {};
      }
      // M45: what I added by hand isn't in a pipeline's whole list, and a complete save would mark it removed.
      if (step.with.complete === true && addedByHand(scope.app, typeName)) {
        errors.push({ path: `${at}.complete`, message: `${typeName} is added by hand too: a pipeline's list isn't the whole of it, so it can't be complete` });
      }
      if (step.with.collection !== undefined) errors.push({ path: `${at}.collection`, message: "saves into a type or a collection, not both" });
      if (step.with.key !== undefined) errors.push({ path: `${at}.key`, message: `${typeName}'s key (${type.key}) identifies its entities` });
      if (Array.isArray(step.with.fields)) step.with.fields.forEach((field, i) => fieldIssue(field, `${at}.fields[${i}]`));
      const items = typeof step.with.items === "string" ? WHOLE_REFERENCE.exec(step.with.items)?.[1]?.trim() : undefined;
      const resolved = items ? this.resolve(items, scope, known) : undefined;
      const element = resolved?.ok && resolved.type.kind === "array" ? resolved.type.element : undefined;
      if (element?.kind === "object") {
        for (const [name, field] of Object.entries(type.fields)) {
          const found = navigate(element, name.split("."));
          if (field.mine && found.ok && found.type.kind !== "unknown") {
            errors.push({ path: `${at}.items`, message: `${typeName}.${name} is mine: a pipeline can't write it` });
          }
        }
        const stage = type.stages?.field;
        if (stage && stage in element.fields && !type.stages!.moves.some((m) => m.by.includes("pipeline"))) {
          errors.push({ path: `${at}.items`, message: `${typeName}.${stage} is moved only by the user: no move of it is by: [pipeline]` });
        }
      }
      return {};
    }

    if (Array.isArray(step.with.where)) {
      step.with.where.forEach((condition, i) => {
        if (condition && typeof condition === "object") fieldIssue((condition as { field?: unknown }).field, `${at}.where[${i}].field`);
      });
    }
    if (typeof step.with.sort === "string") fieldIssue(step.with.sort.replace(/^-/, ""), `${at}.sort`, ["@firstSeen", "@lastSeen"]);
    return {
      output: { kind: "object", fields: { items: { kind: "array", element: entityTypeInfo(type) }, count: { kind: "number" } } },
      ...(type.mine ? {} : { untrusted: typeName }),
    };
  }

  /** file.keep (M46-T4): into a file or image field of one of the App's types that pipelines may write. */
  private checkFileKeep(scope: Scope, inApp: boolean, errors: CompileIssue[]): void {
    const at = `${scope.path}.with`;
    const { type: typeName, field: fieldName } = scope.step.with;
    if (!inApp) {
      errors.push({ path: `${at}.type`, message: "files belong to an App: say which with `app:` at the top of the pipeline" });
      return;
    }
    if (!scope.app || typeof typeName !== "string" || typeof fieldName !== "string") return;
    const type = entityTypeOf(scope.app, typeName);
    if (!type) {
      errors.push({ path: `${at}.type`, message: `"${scope.app.name}" has no type "${typeName}" (types: ${Object.keys(scope.app.types).join(", ")})` });
      return;
    }
    const field = type.fields[fieldName];
    const files = Object.entries(type.fields).flatMap(([name, f]) => (FILE_KINDS.includes(f.type) ? [name] : []));
    if (!field || !FILE_KINDS.includes(field.type)) {
      errors.push({ path: `${at}.field`, message: `${typeName}.${fieldName} isn't a file or an image (${files.length ? `those: ${files.join(", ")}` : "it has none"})` });
    } else if (type.mine || field.mine) {
      errors.push({ path: `${at}.field`, message: `${typeName}.${fieldName} is mine: a pipeline can't write it` });
    }
  }

  /** Resolves a reference path in the scope of a step: {{step.field}}, {{item.field}} or {{cred:name}}. */
  private resolve(path: string, scope: Scope, known: Map<string, CompiledStepInfo>): Resolution {
    if (path.startsWith("cred:")) {
      return /^cred:[a-z0-9][a-z0-9._-]{0,63}$/.test(path)
        ? { ok: true, type: { kind: "string" }, credential: true }
        : { ok: false, message: `{{${path}}} is not a valid credential reference` };
    }
    const [root, ...rest] = path.split(".");
    if (!root || rest.some((segment) => segment.length === 0)) return { ok: false, message: `{{${path}}} is not a valid reference` };

    if (root === "trigger") {
      const data = triggerDataSchema(scope.trigger);
      if (!data) return { ok: false, message: `{{${path}}} is only available in a pipeline triggered by an event or a webhook` };
      const result = navigate(triggerType(describeSchema(data), scope.trigger, scope.app), rest);
      return result.ok ? result : { ok: false, message: `{{${path}}}: ${result.message.replace("the output", "the trigger")}` };
    }

    if (root === "item") {
      if (!scope.itemType) return { ok: false, message: `{{${path}}} is only available in a step with forEach` };
      const result = navigate(scope.itemType, rest);
      return result.ok ? result : { ok: false, message: `{{${path}}}: ${result.message.replace("the output", "the item")}` };
    }

    const source = known.get(root);
    if (!source) {
      const later = scope.step.id === root ? "this step itself" : `"${root}", which is not an earlier step`;
      return { ok: false, message: `{{${path}}} refers to ${later}` };
    }
    const result = navigate(source.output ?? describeSchema(source.definition.output), rest);
    if (!result.ok) return { ok: false, message: `{{${path}}}: ${result.message}` };

    // A forEach step's output is per item. Steps iterating over the same list see the matching item's value;
    // anything else sees the list of all items' values.
    const aligned = source.forEach !== undefined && source.forEach === scope.forEach;
    return source.forEach && !aligned ? { ok: true, type: { kind: "array", element: result.type } } : result;
  }

  /** Target fields of a side-effect step: literals join the static allowlist, single references become provenance rules. */
  private collectTargets(scope: Scope, known: Map<string, CompiledStepInfo>, policy: CompiledPolicy, errors: CompileIssue[]): void {
    for (const [field, kind] of Object.entries(scope.definition.targets ?? {})) {
      const value = scope.step.with[field];
      if (value === undefined) continue;
      const values = Array.isArray(value) ? (value as unknown[]) : [value];
      for (const [i, entry] of values.entries()) {
        const path = `${scope.path}.with.${field}${Array.isArray(value) ? `[${i}]` : ""}`;
        const entity = entityTargetIssue(entry, scope, known);
        if (entity) {
          errors.push({ path, message: entity });
          continue;
        }
        const issue = addTarget(entry, kind, scope.step.id, field, policy, (root) => known.get(root)?.definition, scope.trigger, scope.app);
        if (issue) errors.push({ path, message: issue });
      }
    }
  }

  /**
   * Checks authored gate.act steps and inserts the missing ones (docs/design.md §2.2): every side-effect step needs a gate
   * before it, for the same items. Gates can be added but not removed.
   */
  private placeGates(
    steps: PipelineStep[],
    known: Map<string, CompiledStepInfo>,
    errors: CompileIssue[],
    warnings: CompileIssue[],
  ): CompiledStep[] {
    const covered = new Set<string>();
    steps.forEach((step, index) => {
      if (step.type !== "gate.act") return;
      const target = step.with.for;
      const path = `steps[${index}].with.for`;
      const targetIndex = steps.findIndex((s) => s.id === target);
      const targetStep = steps[targetIndex];
      const targetInfo = typeof target === "string" ? known.get(target) : undefined;
      if (typeof target !== "string" || !targetStep || !targetInfo) {
        errors.push({ path, message: `"${String(target)}" is not a step of this pipeline` });
      } else if (!targetInfo.definition.sideEffect) {
        errors.push({ path, message: `"${target}" (${targetStep.type}) has no side effect to approve` });
      } else if (targetIndex < index) {
        errors.push({ path, message: `the gate must come before "${target}"` });
      } else if (known.get(step.id)?.forEach !== targetInfo.forEach) {
        errors.push({ path, message: `the gate must iterate over the same items as "${target}" (forEach)` });
      } else if (referencesAfter(targetStep, index, steps).length > 0) {
        const late = referencesAfter(targetStep, index, steps).join(", ");
        errors.push({
          path,
          message: `"${target}" uses ${late}, which run after the gate; move the gate after them so it can show the exact payload`,
        });
      } else if (covered.has(target)) {
        errors.push({ path, message: `"${target}" already has a gate` });
      } else {
        covered.add(target);
      }
    });

    const ids = new Set(steps.map((s) => s.id));
    const result: CompiledStep[] = [];
    steps.forEach((step, index) => {
      const info = known.get(step.id);
      if (info?.definition.sideEffect && !covered.has(step.id)) {
        let id = `${step.id}Gate`;
        for (let n = 2; ids.has(id); n++) id = `${step.id}Gate${n}`;
        ids.add(id);
        result.push({
          id,
          type: "gate.act",
          ...(step.forEach ? { forEach: step.forEach } : {}),
          ...(step.when ? { when: step.when } : {}),
          with: { for: step.id },
          autoInserted: true,
        });
        warnings.push({ path: `steps[${index}]`, message: `inserted gate "${id}" before side-effect step "${step.id}"` });
      }
      result.push(step);
    });
    return result;
  }
}

/**
 * A step that writes entities of its own (bill.save, M33) needs its pipeline's App to have that type: the key, each
 * field of the kind it writes, and the states it sets.
 */
function checkContract(
  step: StepDefinition,
  contract: EntityContract,
  appName: string | undefined,
  app: AppDefinition | undefined,
  path: string,
  errors: CompileIssue[],
): void {
  const at = `${path}.type`;
  const verb = contract.mine ? "reads" : "writes";
  if (!appName && contract.optional) return;
  if (!appName) {
    errors.push({ path: at, message: `${step.type} ${verb} ${contract.type} entities: say which App with \`app:\` (one with a ${contract.type} type)` });
    return;
  }
  if (!app) return; // the missing App is already said
  const type = entityTypeOf(app, contract.type);
  if (!type) {
    errors.push({ path: at, message: `${step.type} ${verb} ${contract.type} entities, and "${app.name}" has no type ${contract.type}` });
    return;
  }
  const problems = contractProblems(type, contract);
  if (problems.length > 0) errors.push({ path: at, message: `${step.type} ${verb} ${contract.type} entities: ${problems.join("; ")}` });
}

/** entity.changed (M30) watches a type of the pipeline's own App. */
function checkAppTrigger(trigger: Trigger, app: AppDefinition | undefined, inApp: boolean, errors: CompileIssue[]): void {
  if (!isEventTrigger(trigger) || (trigger.on !== "entity.changed" && trigger.on !== "entity.action")) return;
  if (!inApp) {
    errors.push({ path: "trigger.type", message: `${trigger.on} is about a type of the pipeline's App: say which with \`app:\`` });
    return;
  }
  if (!app || trigger.type === undefined) return;
  const type = entityTypeOf(app, trigger.type);
  if (!type) {
    errors.push({ path: "trigger.type", message: `"${app.name}" has no type "${trigger.type}" (types: ${Object.keys(app.types).join(", ")})` });
    return;
  }
  if (trigger.on !== "entity.changed") return;
  if (trigger.field && !(trigger.field in type.fields)) {
    errors.push({ path: "trigger.field", message: `${trigger.type} has no field "${trigger.field}" (fields: ${Object.keys(type.fields).join(", ")})` });
  }
  if (trigger.stage !== undefined) {
    if (!type.stages) errors.push({ path: "trigger.stage", message: `${trigger.type} has no stages` });
    else if (!type.stages.states.includes(trigger.stage)) {
      errors.push({ path: "trigger.stage", message: `"${trigger.stage}" is not a state of ${trigger.type} (states: ${type.stages.states.join(", ")})` });
    }
  }
}

/** The entity type of an entity.changed or entity.action trigger, when it names one of its App's. */
function triggerEntityType(trigger: Trigger, app: AppDefinition | undefined) {
  if (!isEventTrigger(trigger) || (trigger.on !== "entity.changed" && trigger.on !== "entity.action") || !trigger.type || !app) return undefined;
  return entityTypeOf(app, trigger.type);
}

/** {{trigger.item}} and {{trigger.before}} of entity.changed and entity.action, typed by the entity's type. */
function triggerType(data: TypeInfo, trigger: Trigger, app: AppDefinition | undefined): TypeInfo {
  const type = triggerEntityType(trigger, app);
  if (!type || data.kind !== "object") return data;
  const entity = entityTypeInfo(type);
  return { kind: "object", fields: { ...data.fields, item: entity, ...("before" in data.fields ? { before: entity } : {}) } };
}

/**
 * A target from data.read's items (M32): only from a type of mine, which the user wrote on its form; a type pipelines write
 * holds what pages, feeds and emails said.
 */
function entityTargetIssue(value: unknown, scope: Scope, known: Map<string, CompiledStepInfo>): string | null {
  const source = typeof value === "string" ? WHOLE_REFERENCE.exec(value)?.[1]?.trim() : undefined;
  if (!source) return null;
  const root = source.split(".")[0] ?? "";
  const step = root === "item" ? scope.forEach?.split(".")[0] : root;
  const untrusted = step ? known.get(step)?.untrusted : undefined;
  return untrusted ? `{{${source}}} can't be a target: ${untrusted} is written by pipelines, from what pages, feeds or emails said; only a type of mine can be` : null;
}

/**
 * The page (M27) shows what this pipeline keeps: its collection is one a data.save step of it writes, its chart one
 * its data.history writes. A page button runs a pipeline as a manual run, which one started by an event can't be.
 */
function checkView(definition: PipelineDefinition, errors: CompileIssue[]): void {
  const view = definition.view!;
  const written = (type: string) =>
    new Set(definition.steps.filter((s) => s.type === type && typeof s.with.collection === "string").map((s) => s.with.collection as string));
  if (!written("data.save").has(view.collection)) {
    errors.push({ path: "view.collection", message: `no data.save step of this pipeline writes the collection "${view.collection}"` });
  }
  if (view.detail.history && !written("data.history").has(view.detail.history)) {
    errors.push({ path: "view.detail.history", message: `no data.history step of this pipeline writes "${view.detail.history}"` });
  }
  if (view.chart && !written("data.history").has(view.chart.history)) {
    errors.push({ path: "view.chart.history", message: `no data.history step of this pipeline writes "${view.chart.history}"` });
  }
  const marks = new Set<string>();
  view.marks.forEach((mark, i) => {
    if (marks.has(mark.id)) errors.push({ path: `view.marks[${i}].id`, message: `"${mark.id}" is used by an earlier mark` });
    marks.add(mark.id);
  });
  const labels = new Set<string>();
  view.actions.forEach((action, i) => {
    if (labels.has(action.label)) errors.push({ path: `view.actions[${i}].label`, message: `"${action.label}" is used by an earlier button` });
    labels.add(action.label);
    const self = action.run === "self" || action.run === definition.name;
    if (self && action.row) {
      errors.push({ path: `view.actions[${i}].run`, message: "a row's button starts another pipeline, one triggered by { on: view.action }" });
    } else if (self && (isEventTrigger(definition.trigger) || isWebhookTrigger(definition.trigger))) {
      errors.push({ path: `view.actions[${i}].run`, message: "a pipeline started by an event or a webhook can't be run from a button" });
    }
  });
}

function addTarget(
  value: unknown,
  kind: TargetKind,
  stepId: string,
  field: string,
  policy: CompiledPolicy,
  stepOf: (stepId: string) => StepDefinition | undefined,
  trigger: Trigger,
  app?: AppDefinition,
): string | null {
  if (typeof value !== "string") return `a ${kind} target must be text or a single reference`;
  const whole = WHOLE_REFERENCE.exec(value);
  if (whole?.[1]) {
    const source = whole[1].trim();
    if (source.startsWith("cred:")) return "a credential can't be a target";
    if (source === "trigger" || source.startsWith("trigger.")) {
      // An entity of a type of mine (M32): the user wrote it on its form, so its fields may be targets.
      const mine = triggerEntityType(trigger, app)?.mine && source.startsWith("trigger.item.");
      const issue = mine ? null : triggerTargetIssue(trigger, source);
      if (issue) return issue;
      policy.provenance.push({ stepId, field, kind, source });
      return null;
    }
    // Targets come from data (a fetched email, a job posting), never from text an LLM wrote (docs/design.md §1.4).
    const root = stepOf(source.split(".")[0] ?? "");
    const fromPage = root?.pageFields?.includes(source.split(".")[1] ?? "") && source.split(".").length === 2;
    if (root?.llmOutput && !fromPage) return `a ${kind} can't come from LLM output ({{${source}}} is written by ${root.type})`;
    const rule: ProvenanceRule = { stepId, field, kind, source };
    policy.provenance.push(rule);
    return null;
  }
  const hasReferences = referencesIn(value).length > 0;
  if (kind === "recipient") {
    if (hasReferences) return "a recipient must be a literal address or a single reference";
    if (!EMAIL.test(value)) return `"${value}" is not an email address`;
    policy.allowedRecipients.push(value.toLowerCase());
    return null;
  }
  // domain: a literal URL, or a URL whose host is literal and only the path has references
  const host = /^https?:\/\/([^/{}?#:]+)(?::\d+)?(?:[/?#]|$)/i.exec(value)?.[1];
  if (!host)
    return hasReferences
      ? "the host of a target URL must be literal, or the whole URL a single reference"
      : `"${value}" is not an http(s) URL`;
  policy.allowedDomains.push(host.toLowerCase());
  return null;
}

/** Steps (by id) that `step` references and that come at or after position `index`. */
function referencesAfter(step: PipelineStep, index: number, steps: PipelineStep[]): string[] {
  const later = new Set(steps.slice(index).map((s) => s.id));
  const roots = [...referencesIn(step.with), ...(step.forEach ? referencesIn(step.forEach) : [])].map((r) => r.split(".")[0] ?? "");
  return [...new Set(roots.filter((root) => later.has(root)))];
}

/** All reference paths inside a value (strings anywhere in arrays and objects). */
export function referencesIn(value: unknown): string[] {
  if (typeof value === "string") return [...value.matchAll(REFERENCE)].map((m) => (m[1] ?? "").trim());
  if (Array.isArray(value)) return value.flatMap(referencesIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(referencesIn);
  return [];
}

/** The literal URLs of a field (text without references), with their index in a list. */
/** The literal addresses in a reads field, with where each is: a string, a list of them, or a list of { url } (shop.product). */
function literalUrls(value: unknown): [string, string][] {
  const values = Array.isArray(value) ? value.map((v, i): [string, unknown] => [`[${i}]`, v]) : [["", value] as [string, unknown]];
  return values
    .map(([at, v]): [string, unknown] => (typeof v === "object" && v !== null && "url" in v ? [`${at}.url`, v.url] : [at, v]))
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && referencesIn(entry[1]).length === 0);
}

function referencePath(wholeReference: string): string {
  return (WHOLE_REFERENCE.exec(wholeReference)?.[1] ?? "").trim();
}

function formatPath(path: PropertyKey[]): string {
  return path.map((segment, i) => (typeof segment === "number" ? `[${segment}]` : `${i ? "." : ""}${String(segment)}`)).join("");
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

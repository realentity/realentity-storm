import {
  PipelineDefinitionSchema,
  REFERENCE,
  WHOLE_REFERENCE,
  type CompiledDefinition,
  type CompiledPolicy,
  type CompiledStep,
  type CompileIssue,
  type CompileResult,
  type PipelineStep,
  type ProvenanceRule,
  type TargetKind,
} from "@ai-me/shared";
import { parse as parseYaml } from "yaml";
import { type z } from "zod";
import { defaultCatalog, type StepCatalog, type StepDefinition } from "./catalog";
import { describeSchema, formatType, isAssignable, isOptional, navigate, UNKNOWN, type TypeInfo } from "./type-info";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface CompiledStepInfo {
  definition: StepDefinition;
  /** The forEach source path ("search.items"), when the step fans out. */
  forEach?: string;
}

interface Scope {
  step: PipelineStep;
  definition: StepDefinition;
  path: string;
  forEach?: string;
  itemType?: TypeInfo;
}

type Resolution = { ok: true; type: TypeInfo; credential?: boolean } | { ok: false; message: string };

/**
 * Compiles a pipeline definition (README §2.1–2.2): validates its structure and every step against the catalog,
 * checks {{references}} and their types, inserts the gates side-effect steps need, and derives the policy
 * (what side-effect steps may target). The runner only ever executes what this produced.
 */
export class PipelineCompiler {
  constructor(private readonly catalog: StepCatalog = defaultCatalog()) {}

  /** From YAML (or JSON, which is YAML). */
  compileText(text: string): CompileResult {
    let parsed: unknown;
    try {
      parsed = parseYaml(text);
    } catch (error) {
      return { ok: false, errors: [{ path: "", message: `Not valid YAML: ${error instanceof Error ? error.message : String(error)}` }] };
    }
    return this.compile(parsed);
  }

  compile(input: unknown): CompileResult {
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

    definition.steps.forEach((step, index) => {
      const path = `steps[${index}]`;
      if (ids.has(step.id)) errors.push({ path: `${path}.id`, message: `"${step.id}" is used by an earlier step` });
      ids.add(step.id);

      const stepDefinition = this.catalog.get(step.type);
      if (!stepDefinition) {
        errors.push({ path: `${path}.type`, message: `unknown step type "${step.type}"` });
        return;
      }

      const scope: Scope = { step, definition: stepDefinition, path };
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

      if (stepDefinition.sideEffect && step.retries) {
        errors.push({ path: `${path}.retries`, message: "side-effect steps are never retried automatically" });
      }

      this.checkInputs(scope, known, errors);
      if (stepDefinition.sideEffect) this.collectTargets(scope, known, policy, errors);
      known.set(step.id, { definition: stepDefinition, forEach: scope.forEach });
    });

    for (const [type] of Object.entries(definition.limits)) {
      const limited = this.catalog.get(type);
      if (!limited) errors.push({ path: `limits.${type}`, message: `unknown step type "${type}"` });
      // The runner applies limits before a side effect executes (README §2.2); elsewhere they would do nothing.
      else if (!limited.sideEffect) errors.push({ path: `limits.${type}`, message: "only side-effect steps have rate limits" });
    }

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
      if (credentialUsed && !scope.definition.acceptsCredentials) {
        errors.push({
          path: fieldPath,
          message: `${scope.step.type} can't receive credentials ({{cred:…}}); they never reach the LLM or notifications`,
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

  /** Resolves a reference path in the scope of a step: {{step.field}}, {{item.field}} or {{cred:name}}. */
  private resolve(path: string, scope: Scope, known: Map<string, CompiledStepInfo>): Resolution {
    if (path.startsWith("cred:")) {
      return /^cred:[a-z0-9][a-z0-9._-]{0,63}$/.test(path)
        ? { ok: true, type: { kind: "string" }, credential: true }
        : { ok: false, message: `{{${path}}} is not a valid credential reference` };
    }
    const [root, ...rest] = path.split(".");
    if (!root || rest.some((segment) => segment.length === 0)) return { ok: false, message: `{{${path}}} is not a valid reference` };

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
    const result = navigate(describeSchema(source.definition.output), rest);
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
        const issue = addTarget(entry, kind, scope.step.id, field, policy, (root) => known.get(root)?.definition);
        if (issue) errors.push({ path, message: issue });
      }
    }
  }

  /**
   * Checks authored gate.act steps and inserts the missing ones (README §2.2): every side-effect step needs a gate
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

function addTarget(
  value: unknown,
  kind: TargetKind,
  stepId: string,
  field: string,
  policy: CompiledPolicy,
  stepOf: (stepId: string) => StepDefinition | undefined,
): string | null {
  if (typeof value !== "string") return `a ${kind} target must be text or a single reference`;
  const whole = WHOLE_REFERENCE.exec(value);
  if (whole?.[1]) {
    const source = whole[1].trim();
    if (source.startsWith("cred:")) return "a credential can't be a target";
    // Targets come from data (a fetched email, a job posting), never from text an LLM wrote (README §1.4).
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

function referencePath(wholeReference: string): string {
  return (WHOLE_REFERENCE.exec(wholeReference)?.[1] ?? "").trim();
}

function formatPath(path: PropertyKey[]): string {
  return path.map((segment, i) => (typeof segment === "number" ? `[${segment}]` : `${i ? "." : ""}${String(segment)}`)).join("");
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

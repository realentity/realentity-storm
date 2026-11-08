import { hostMatches, type CompiledPolicy, type TargetKind } from "@realentity/storm-shared";
import { type StepDefinition } from "@realentity/storm-steps";

export interface TargetCheck {
  field: string;
  kind: TargetKind;
  /** The host for domains, the address for recipients. */
  value: string;
  /** static: in the pipeline's allowlist. provenance: equals the value its source step actually produced. */
  basis: "static" | "provenance" | "approved" | null;
  /** Not in the static allowlist: the gate highlights it ("New domain: X"). */
  isNew: boolean;
}

export class PolicyViolation extends Error {}

/**
 * Run-time side of the pipeline policy (README §2.2): what a side-effect step targets must be in the static lists,
 * equal to what its provenance source produced, or explicitly approved as new at the gate.
 */
export class PolicyGuard {
  /** Classifies every target of a side-effect payload. `sourceValue` resolves a provenance source path in the run. */
  static check(
    policy: CompiledPolicy,
    definition: StepDefinition,
    stepId: string,
    payload: Record<string, unknown>,
    sourceValue: (path: string) => unknown,
    approvedNew: readonly string[] = [],
  ): TargetCheck[] {
    const checks: TargetCheck[] = [];
    for (const [field, kind] of Object.entries(definition.targets ?? {})) {
      const raw = payload[field];
      if (raw === undefined) continue;
      const rule = policy.provenance.find((r) => r.stepId === stepId && r.field === field);
      const fromSource = rule ? normalizeAll(sourceValue(rule.source), kind) : [];
      for (const entry of Array.isArray(raw) ? (raw as unknown[]) : [raw]) {
        const value = normalize(entry, kind);
        if (value === null) {
          checks.push({ field, kind, value: String(entry), basis: null, isNew: true });
          continue;
        }
        const isStatic = kind === "domain" ? hostMatches(value, policy.allowedDomains) : policy.allowedRecipients.includes(value);
        const basis = isStatic ? "static" : fromSource.includes(value) ? "provenance" : approvedNew.includes(value) ? "approved" : null;
        checks.push({ field, kind, value, basis, isNew: !isStatic });
      }
    }
    return checks;
  }

  /** Throws unless every target is allowed. */
  static enforce(...args: Parameters<typeof PolicyGuard.check>): TargetCheck[] {
    const checks = PolicyGuard.check(...args);
    const refused = checks.filter((c) => c.basis === null);
    if (refused.length > 0) {
      throw new PolicyViolation(`Policy refused ${refused.map((c) => `${c.kind} "${c.value}" (${c.field})`).join(", ")}`);
    }
    return checks;
  }
}

function normalizeAll(value: unknown, kind: TargetKind): string[] {
  const values = Array.isArray(value) ? (value as unknown[]) : [value];
  return values.map((v) => normalize(v, kind)).filter((v): v is string => v !== null);
}

/** Domains compare by host (from a URL), recipients by lowercase address. */
function normalize(value: unknown, kind: TargetKind): string | null {
  if (typeof value !== "string") return null;
  if (kind === "recipient") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? value.trim().toLowerCase() : null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

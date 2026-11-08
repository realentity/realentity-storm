import { REFERENCE, WHOLE_REFERENCE, type CompiledStep } from "@realentity/storm-shared";

/** The current forEach item of the step being resolved. */
export interface ItemScope {
  /** The forEach source path, e.g. "shortlist.selected". */
  source: string;
  index: number;
  item: unknown;
}

export class ReferenceError extends Error {}

/**
 * Step outputs of a run, and {{reference}} resolution against them (the run-time side of the compiler's checks).
 * A forEach step's output is a list by item index (undefined for skipped items); steps over the same list see
 * the matching item's value, others the list of all values.
 */
export class RunValues {
  private readonly outputs = new Map<string, { forEach?: string; value: unknown }>();

  /** `trigger`: {{trigger.*}}, the event or webhook call that started the run (M12); null for other runs. */
  constructor(private readonly trigger: unknown = null) {}

  set(step: CompiledStep, value: unknown): void {
    this.outputs.set(step.id, { forEach: step.forEach ? sourceOf(step.forEach) : undefined, value });
  }

  /** Resolves every reference inside a value. {{cred:…}} stays as it is: only the worker's executors resolve it, at use. */
  resolve(value: unknown, scope?: ItemScope): unknown {
    if (typeof value === "string") {
      const whole = WHOLE_REFERENCE.exec(value);
      if (whole?.[1]) {
        const path = whole[1].trim();
        return path.startsWith("cred:") ? value : this.lookup(path, scope);
      }
      return value.replace(REFERENCE, (match, path: string) =>
        path.trim().startsWith("cred:") ? match : asText(this.lookup(path.trim(), scope)),
      );
    }
    if (Array.isArray(value)) return value.map((v) => this.resolve(v, scope));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.resolve(v, scope)]));
    }
    return value;
  }

  lookup(path: string, scope?: ItemScope): unknown {
    const [root, ...rest] = path.split(".");
    if (root === "trigger") return dig(this.trigger, rest, path);
    if (root === "item") {
      if (!scope) throw new ReferenceError(`{{${path}}} outside a forEach step`);
      return dig(scope.item, rest, path);
    }
    const entry = this.outputs.get(root ?? "");
    if (!entry) throw new ReferenceError(`{{${path}}}: step "${root}" has no output (yet)`);
    if (entry.forEach === undefined) return dig(entry.value, rest, path);
    const perItem = entry.value as unknown[];
    if (scope && scope.source === entry.forEach) return dig(perItem[scope.index], rest, path);
    return perItem.map((v) => (v === undefined ? undefined : dig(v, rest, path)));
  }
}

export function sourceOf(forEach: string): string {
  return (WHOLE_REFERENCE.exec(forEach)?.[1] ?? "").trim();
}

function dig(value: unknown, segments: string[], path: string): unknown {
  let current = value;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object" || Array.isArray(current))
      throw new ReferenceError(`{{${path}}}: can't read "${segment}" of a ${Array.isArray(current) ? "list" : typeof current}`);
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

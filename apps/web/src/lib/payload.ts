import { canonicalJson, type TargetView } from "@realentity/storm-shared";

/** Top-level fields whose value differs (as the api records it in the Decision). */
export function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter((key) => canonicalJson(before[key] ?? null) !== canonicalJson(after[key] ?? null));
}

/**
 * The editor shows each field on its own: strings as plain text, everything else as JSON. Returns the edited
 * payload, or the fields whose JSON doesn't parse.
 */
export function readEdits(
  original: Record<string, unknown>,
  texts: Record<string, string>,
): { ok: true; payload: Record<string, unknown> } | { ok: false; invalid: string[] } {
  const payload: Record<string, unknown> = {};
  const invalid: string[] = [];
  for (const [field, value] of Object.entries(original)) {
    const text = texts[field];
    if (text === undefined) {
      payload[field] = value;
    } else if (typeof value === "string") {
      payload[field] = text;
    } else {
      try {
        payload[field] = JSON.parse(text) as unknown;
      } catch {
        invalid.push(field);
      }
    }
  }
  return invalid.length > 0 ? { ok: false, invalid } : { ok: true, payload };
}

export function editableText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/**
 * Targets an edit introduces: values of the target fields that weren't among the proposal's targets. They need the
 * user's explicit approval (the worker refuses them otherwise). Normalized as the worker does: hosts of URLs for domains,
 * lowercase addresses for recipients.
 */
export function newTargets(targets: readonly TargetView[], edited: Record<string, unknown>): string[] {
  const known = new Set(targets.map((t) => t.value));
  const fields = new Map(targets.map((t) => [t.field, t.kind]));
  const out = new Set<string>();
  for (const [field, kind] of fields) {
    const raw = edited[field];
    for (const entry of Array.isArray(raw) ? (raw as unknown[]) : [raw]) {
      const value = normalizeTarget(entry, kind);
      if (value && !known.has(value)) out.add(value);
    }
  }
  return [...out];
}

function normalizeTarget(value: unknown, kind: TargetView["kind"]): string | null {
  if (typeof value !== "string") return null;
  if (kind === "recipient") return value.trim().toLowerCase() || null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

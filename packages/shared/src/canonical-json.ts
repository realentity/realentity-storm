/**
 * JSON with object keys sorted (by code point, never locale), so equal values always give the same text.
 * Used to compare definitions and to hash approved payloads (the api hashes on approval, the worker checks before acting).
 */
export function canonicalJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, v: unknown) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
        : v,
    ) ?? "undefined"
  );
}

/**
 * M52: an encrypted field's value as an entity, a step's output or a trigger holds it: sealed like a credential
 * (docs/design.md §7), base64. Pipelines move it as it is; only the worker opens it, as an `http.request` sends it.
 * Nothing here opens one: this is what every reader needs to recognise and mask it.
 */
export interface SealedValue {
  $sealed: {
    /** Where it belongs ("Secrets/Secret/API_TOKEN/value" with the App's id): the AAD, so it opens only there. */
    at: string;
    ciphertext: string;
    iv: string;
    authTag: string;
    wrappedDek: string;
    keyVersion: number;
    /** A keyed hash of the value (HMAC-SHA256, hex): whether it changed, without opening it. */
    hash: string;
    /** The root key version the hash is keyed with. */
    hashKeyVersion: number;
  };
}

/** What a sealed value is shown as: in logs, run pages, gates, Telegram, the LLM. */
export const MASK = "***";

export function isSealed(value: unknown): value is SealedValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const sealed = (value as { $sealed?: unknown }).$sealed;
  return (
    !!sealed &&
    typeof sealed === "object" &&
    typeof (sealed as { at?: unknown }).at === "string" &&
    typeof (sealed as { ciphertext?: unknown }).ciphertext === "string"
  );
}

/** Where a field's sealed value belongs: its App, type, entity key and field. */
export function sealedAt(appId: string, type: string, key: string, field: string): string {
  return `${appId}/${type}/${encodeURIComponent(key)}/${field}`;
}

/** The value with every sealed value in it as `***`: for anything shown or sent to the LLM. */
export function maskSealed<T>(value: T): T {
  return mask(value, 0) as T;
}

function mask(value: unknown, depth: number): unknown {
  if (isSealed(value)) return MASK;
  if (depth > 50 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => mask(v, depth + 1));
  if (!isPlain(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v, depth + 1)]));
}

/**
 * A plain object (JSON's): a class instance (a Date, a file's stream) is left as it is. Its prototype is a root one, of
 * whichever realm made it (structuredClone's objects aren't a vm context's, as under Jest).
 */
function isPlain(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/** Does it hold a sealed value anywhere? */
export function holdsSealed(value: unknown, depth = 0): boolean {
  if (isSealed(value)) return true;
  if (depth > 50 || !value || typeof value !== "object") return false;
  return Object.values(value).some((v) => holdsSealed(v, depth + 1));
}

/** The value with each sealed value as its hash: two seals of one value compare equal (iv and data key differ). */
export function comparableSealed<T>(value: T, depth = 0): T {
  if (isSealed(value)) return { $sealed: value.$sealed.hash } as T;
  if (depth > 50 || !value || typeof value !== "object" || value instanceof Date) return value;
  if (Array.isArray(value)) return (value as unknown[]).map((v) => comparableSealed(v, depth + 1)) as T;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, comparableSealed(v, depth + 1)])) as T;
}

/**
 * An entity's item with each encrypted field's sealed value kept only when it belongs there (its `at`): one copied
 * from another entity or field in the database is left out, as its AAD would refuse it anyway.
 */
export function inPlace(item: Record<string, unknown>, fields: readonly string[], at: (field: string) => string): Record<string, unknown> {
  for (const field of fields) {
    const value = item[field];
    if (value !== undefined && value !== null && !(isSealed(value) && value.$sealed.at === at(field))) delete item[field];
  }
  return item;
}

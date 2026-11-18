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

/**
 * M57: where a credential field's handle belongs: data.read seals the credential's id there (never its secret), and
 * the worker, opening it as a request sends it, reveals that credential for the request's host only.
 */
export function credentialAt(appId: string, type: string, key: string, field: string): string {
  return `${CREDENTIAL_AT}${sealedAt(appId, type, key, field)}`;
}

const CREDENTIAL_AT = "cred:";

/** M57: a handle to a credential (its id sealed), not to a value. An App's id is a UUID, so a field's never starts so. */
export function isCredentialHandle(value: SealedValue): boolean {
  return value.$sealed.at.startsWith(CREDENTIAL_AT);
}

/** The value with every sealed value in it as `***`: for anything shown or sent to the LLM. */
export function maskSealed<T>(value: T): T {
  return mask(value, 0) as T;
}

function mask(value: unknown, depth: number): unknown {
  if (isSealed(value)) return MASK;
  if (typeof value === "string") return value.includes(TOKEN_START) ? value.replace(SEALED_TOKEN, MASK) : value;
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

/** Does it hold a sealed value anywhere (a handle, or one in text as a token)? */
export function holdsSealed(value: unknown, depth = 0): boolean {
  if (isSealed(value)) return true;
  if (typeof value === "string") return value.includes(TOKEN_START) && new RegExp(SEALED_TOKEN.source).test(value);
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

// --- a handle in text (M52-T5) ---

const TOKEN_START = "{{sealed:";
/** A handle inside text ("Bearer {{item.token}}"): the sealed value as base64url JSON, opened only as it is sent. */
export const SEALED_TOKEN = /\{\{sealed:([A-Za-z0-9_-]+)((?:\|[A-Za-z][A-Za-z0-9]*(?::[A-Za-z0-9_-]*)?)*)\}\}/g;

// UTF-8 text to base64url and back (btoa and atob take Latin-1).
const toBase64Url = (text: string) =>
  btoa(Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromBase64Url = (text: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

/** The handle as text: what a template puts where it is written inside a string. Only ciphertext, never the value. */
export function sealedToken(value: SealedValue, transforms: readonly { name: string; argument?: string }[] = []): string {
  // M52-T9: the transforms to apply once it is opened, each argument (a public key) as base64url.
  const after = transforms.map((t) => `|${t.name}${t.argument === undefined ? "" : `:${toBase64Url(t.argument)}`}`).join("");
  return `${TOKEN_START}${toBase64Url(JSON.stringify(value))}${after}}}`;
}

/** A token's transforms (its second group, "|base64|sealedBox:…"), their arguments decoded. */
export function tokenTransforms(group: string | undefined): { name: string; argument?: string }[] {
  return (group ?? "")
    .split("|")
    .filter(Boolean)
    .map((part) => {
      const colon = part.indexOf(":");
      return colon < 0 ? { name: part } : { name: part.slice(0, colon), argument: fromBase64Url(part.slice(colon + 1)) };
    });
}

/** The handle a token holds, or null when it isn't one. */
export function fromSealedToken(encoded: string): SealedValue | null {
  try {
    const value: unknown = JSON.parse(fromBase64Url(encoded));
    return isSealed(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * A payload the user edited at a gate, with the handles it showed as *** put back: a field left as *** keeps its handle,
 * and text keeps its tokens in order where it still shows as many ***. A handle the user replaced by a value is theirs.
 */
export function unmaskEdit(original: unknown, edited: unknown, depth = 0): unknown {
  if (depth > 50) return edited;
  if (isSealed(original)) return edited === MASK ? original : edited;
  if (typeof original === "string" && typeof edited === "string") {
    const tokens = original.match(SEALED_TOKEN) ?? [];
    if (tokens.length === 0) return edited;
    const parts = edited.split(MASK);
    if (parts.length - 1 !== tokens.length) return edited;
    return parts.reduce((text, part, i) => text + (i > 0 ? tokens[i - 1] : "") + part, "");
  }
  if (Array.isArray(original) && Array.isArray(edited)) return edited.map((v, i) => unmaskEdit(original[i], v, depth + 1));
  if (original && edited && typeof original === "object" && typeof edited === "object" && !Array.isArray(edited)) {
    const before = original as Record<string, unknown>;
    return Object.fromEntries(Object.entries(edited).map(([k, v]) => [k, unmaskEdit(before[k], v, depth + 1)]));
  }
  return edited;
}

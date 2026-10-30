import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { type KeyRing } from "./key-ring";

const ALG = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;
const WRAPPED_DEK_BYTES = IV_BYTES + TAG_BYTES + DEK_BYTES;

/** Bytes backed by a plain ArrayBuffer: what Prisma stores and returns for `Bytes` columns. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** What is stored per secret. Inputs accept any byte view; outputs are copies the caller may store as they are. */
export interface SealedSecret {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
  /** iv(12) + tag(16) + encrypted DEK(32) */
  wrappedDek: Uint8Array;
  keyVersion: number;
}

export interface SealedSecretBytes extends SealedSecret {
  ciphertext: Bytes;
  iv: Bytes;
  authTag: Bytes;
  wrappedDek: Bytes;
}

const bytes = (buffer: Buffer): Bytes => new Uint8Array(buffer);

function enc(key: Buffer, plain: Buffer, aad: Buffer): { iv: Buffer; ct: Buffer; tag: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv(ALG, key, iv).setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { iv, ct, tag: c.getAuthTag() };
}

function dec(key: Buffer, iv: Uint8Array, ct: Uint8Array, tag: Uint8Array, aad: Buffer): Buffer {
  const d = createDecipheriv(ALG, key, iv).setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

function wrap(keys: KeyRing, keyVersion: number, dek: Buffer, aad: Buffer): Bytes {
  const w = enc(keys.key(keyVersion), dek, aad);
  return bytes(Buffer.concat([w.iv, w.tag, w.ct]));
}

function unwrap(keys: KeyRing, keyVersion: number, wrappedDek: Uint8Array, aad: Buffer): Buffer {
  if (wrappedDek.length !== WRAPPED_DEK_BYTES) {
    throw new Error("Malformed wrapped data key");
  }
  const wk = Buffer.from(wrappedDek);
  return dec(
    keys.key(keyVersion),
    wk.subarray(0, IV_BYTES),
    wk.subarray(IV_BYTES + TAG_BYTES),
    wk.subarray(IV_BYTES, IV_BYTES + TAG_BYTES),
    aad,
  );
}

/**
 * Encrypts a secret with its own random data key (DEK), and wraps the DEK with the current root key.
 * `id` is the row id, generated before insert; it is the AAD, so a sealed value only opens for its own row.
 */
export function seal(keys: KeyRing, id: string, secret: string): SealedSecretBytes {
  const dek = randomBytes(DEK_BYTES);
  const aad = Buffer.from(id);
  try {
    const v = enc(dek, Buffer.from(secret, "utf8"), aad);
    return {
      ciphertext: bytes(v.ct),
      iv: bytes(v.iv),
      authTag: bytes(v.tag),
      wrappedDek: wrap(keys, keys.currentVersion, dek, aad),
      keyVersion: keys.currentVersion,
    };
  } finally {
    dek.fill(0);
  }
}

/** Decrypts a sealed secret. Throws if anything was tampered with, the row id differs, or the key version is missing. */
export function open(keys: KeyRing, id: string, sealed: SealedSecret): string {
  const aad = Buffer.from(id);
  const dek = unwrap(keys, sealed.keyVersion, sealed.wrappedDek, aad);
  try {
    return dec(dek, sealed.iv, sealed.ciphertext, sealed.authTag, aad).toString("utf8");
  } finally {
    dek.fill(0);
  }
}

/** Re-wraps the data key with another root key version (rotation). The secret itself is never decrypted. */
export function rewrap(
  keys: KeyRing,
  id: string,
  sealed: Pick<SealedSecret, "wrappedDek" | "keyVersion">,
  toVersion: number = keys.currentVersion,
): { wrappedDek: Bytes; keyVersion: number } {
  const aad = Buffer.from(id);
  const dek = unwrap(keys, sealed.keyVersion, sealed.wrappedDek, aad);
  try {
    return { wrappedDek: wrap(keys, toVersion, dek, aad), keyVersion: toVersion };
  } finally {
    dek.fill(0);
  }
}

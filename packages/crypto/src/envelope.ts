import { createCipheriv, createDecipheriv, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { type KeyRing } from "./key-ring";
import { publicKeyOfRaw, rawPublicKey, sealKeysOf, sealPrivateKey, type SealingKeys, type SealKeys } from "./seal-keys";

const ALG = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;
const X25519_BYTES = 32;
/** Wrapped with the root key itself: iv + tag + encrypted DEK. Before M64, and still the integrations' (M62). */
const WRAPPED_DEK_BYTES = IV_BYTES + TAG_BYTES + DEK_BYTES;
/** M64: wrapped to the version's X25519 public key: ephemeral public key + iv + tag + encrypted DEK. */
const PUBLIC_WRAPPED_DEK_BYTES = X25519_BYTES + WRAPPED_DEK_BYTES;
const WRAP_INFO = "storm:dek-wrap";

/** Bytes backed by a plain ArrayBuffer: what Prisma stores and returns for `Bytes` columns. */
export type Bytes = Uint8Array<ArrayBuffer>;

/** What is stored per secret. Inputs accept any byte view; outputs are copies the caller may store as they are. */
export interface SealedSecret {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  authTag: Uint8Array;
  /**
   * The DEK, wrapped: to the root key version's X25519 public key (M64: ephemeral public key(32) + iv(12) + tag(16) +
   * encrypted DEK(32)), or with the root key itself (before M64, and the integrations': iv + tag + encrypted DEK).
   */
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

function wrapSymmetric(keys: KeyRing, keyVersion: number, dek: Buffer, aad: Buffer): Bytes {
  const w = enc(keys.key(keyVersion), dek, aad);
  return bytes(Buffer.concat([w.iv, w.tag, w.ct]));
}

/** The key that wraps a DEK between an X25519 pair: HKDF over the shared secret, bound to both public keys. */
function wrapKey(shared: Buffer, ephemeral: Buffer, recipient: Buffer): Buffer {
  // A low-order point gives an all-zero secret anyone could compute: never a key.
  if (shared.every((b) => b === 0)) throw new Error("Malformed wrapped data key");
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephemeral, recipient]), WRAP_INFO, DEK_BYTES));
}

/** M64: the DEK wrapped to the version's public key, so sealing needs no secret that opens (ECIES: X25519, HKDF, AES-GCM). */
function wrapPublic(keys: SealKeys, keyVersion: number, dek: Buffer, aad: Buffer): Bytes {
  const recipient = keys.publicKey(keyVersion);
  const pair = generateKeyPairSync("x25519");
  const ephemeral = rawPublicKey(pair.publicKey);
  const kek = wrapKey(diffieHellman({ privateKey: pair.privateKey, publicKey: recipient }), ephemeral, rawPublicKey(recipient));
  try {
    const w = enc(kek, dek, aad);
    return bytes(Buffer.concat([ephemeral, w.iv, w.tag, w.ct]));
  } finally {
    kek.fill(0);
  }
}

function unwrap(keys: KeyRing, keyVersion: number, wrappedDek: Uint8Array, aad: Buffer): Buffer {
  const wk = Buffer.from(wrappedDek);
  if (wk.length === WRAPPED_DEK_BYTES) {
    return dec(keys.key(keyVersion), wk.subarray(0, IV_BYTES), wk.subarray(IV_BYTES + TAG_BYTES), wk.subarray(IV_BYTES, IV_BYTES + TAG_BYTES), aad);
  }
  if (wk.length !== PUBLIC_WRAPPED_DEK_BYTES) throw new Error("Malformed wrapped data key");
  const privateKey = sealPrivateKey(keys.key(keyVersion));
  const ephemeral = wk.subarray(0, X25519_BYTES);
  let shared: Buffer;
  try {
    shared = diffieHellman({ privateKey, publicKey: publicKeyOfRaw(ephemeral) });
  } catch {
    throw new Error("Malformed wrapped data key");
  }
  const kek = wrapKey(shared, ephemeral, rawPublicKey(privateKey));
  try {
    const rest = wk.subarray(X25519_BYTES);
    return dec(kek, rest.subarray(0, IV_BYTES), rest.subarray(IV_BYTES + TAG_BYTES), rest.subarray(IV_BYTES, IV_BYTES + TAG_BYTES), aad);
  } finally {
    kek.fill(0);
  }
}

function sealWith(id: string, secret: string, wrapDek: (dek: Buffer, aad: Buffer) => Bytes, keyVersion: number): SealedSecretBytes {
  const dek = randomBytes(DEK_BYTES);
  const aad = Buffer.from(id);
  try {
    const v = enc(dek, Buffer.from(secret, "utf8"), aad);
    return { ciphertext: bytes(v.ct), iv: bytes(v.iv), authTag: bytes(v.tag), wrappedDek: wrapDek(dek, aad), keyVersion };
  } finally {
    dek.fill(0);
  }
}

/**
 * Encrypts a secret with its own random data key (DEK), and wraps the DEK to the current root key version's public key
 * (M64): the api seals with SealKeys alone, and only the worker's KeyRing opens it. `id` is the row id, generated before
 * insert; it is the AAD, so a sealed value only opens for its own row.
 */
export function seal(keys: SealingKeys, id: string, secret: string): SealedSecretBytes {
  const sealKeys = sealKeysOf(keys);
  return sealWith(id, secret, (dek, aad) => wrapPublic(sealKeys, sealKeys.currentVersion, dek, aad), sealKeys.currentVersion);
}

/** The DEK wrapped with the ring's key itself: the integrations' secrets (M62), which the api opens too. */
export function sealSymmetric(ring: KeyRing, id: string, secret: string): SealedSecretBytes {
  return sealWith(id, secret, (dek, aad) => wrapSymmetric(ring, ring.currentVersion, dek, aad), ring.currentVersion);
}

/**
 * Decrypts a sealed secret, wrapped either way. Throws if anything was tampered with, the row id differs, or the key
 * version is missing.
 */
export function open(keys: KeyRing, id: string, sealed: SealedSecret): string {
  const aad = Buffer.from(id);
  const dek = unwrap(keys, sealed.keyVersion, sealed.wrappedDek, aad);
  try {
    return dec(dek, sealed.iv, sealed.ciphertext, sealed.authTag, aad).toString("utf8");
  } finally {
    dek.fill(0);
  }
}

/** Wrapped to a public key (M64), not with the root key itself: what `pnpm keys:rotate` leaves every secret as. */
export function wrappedToPublicKey(sealed: Pick<SealedSecret, "wrappedDek">): boolean {
  return sealed.wrappedDek.length === PUBLIC_WRAPPED_DEK_BYTES;
}

/** Rotation moves it: an older root key version, or wrapped the pre-M64 way. */
export function needsRewrap(sealed: Pick<SealedSecret, "wrappedDek" | "keyVersion">, toVersion: number): boolean {
  return sealed.keyVersion !== toVersion || !wrappedToPublicKey(sealed);
}

/**
 * Re-wraps the data key for another root key version, to its public key (rotation; M64: a pre-M64 DEK is moved to the
 * public key on the way). The secret itself is never decrypted.
 */
export function rewrap(
  keys: KeyRing,
  id: string,
  sealed: Pick<SealedSecret, "wrappedDek" | "keyVersion">,
  toVersion: number = keys.currentVersion,
): { wrappedDek: Bytes; keyVersion: number } {
  const aad = Buffer.from(id);
  const dek = unwrap(keys, sealed.keyVersion, sealed.wrappedDek, aad);
  try {
    return { wrappedDek: wrapPublic(sealKeysOf(keys), toVersion, dek, aad), keyVersion: toVersion };
  } finally {
    dek.fill(0);
  }
}

/** Rotation of a ring's own wrapping (the integrations'): the DEK re-wrapped with another version of that ring. */
export function rewrapSymmetric(
  ring: KeyRing,
  id: string,
  sealed: Pick<SealedSecret, "wrappedDek" | "keyVersion">,
  toVersion: number = ring.currentVersion,
): { wrappedDek: Bytes; keyVersion: number } {
  const aad = Buffer.from(id);
  const dek = unwrap(ring, sealed.keyVersion, sealed.wrappedDek, aad);
  try {
    return { wrappedDek: wrapSymmetric(ring, toVersion, dek, aad), keyVersion: toVersion };
  } finally {
    dek.fill(0);
  }
}

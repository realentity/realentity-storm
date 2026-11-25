import { type SealedValue } from "@realentity/storm-shared";
import { createHmac } from "node:crypto";
import { needsRewrap, open, rewrap, seal } from "./envelope";
import { type KeyRing } from "./key-ring";
import { sealKeysOf, type SealingKeys } from "./seal-keys";

/**
 * M52: an encrypted field's value, sealed for where it belongs (`at`: the AAD) and kept in the entity's JSON. The api
 * and the worker seal; only the worker opens (M64: the api has no key that does; its ESLint rule forbids `openField`
 * and `rewrapField` too).
 */

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const bytes = (text: string) => new Uint8Array(Buffer.from(text, "base64"));

/** A keyed hash of the value: the same value hashes the same under one root key, and says nothing of it without the key. */
export function fieldHash(keys: SealingKeys, value: string, keyVersion: number = keys.currentVersion): string {
  return createHmac("sha256", sealKeysOf(keys).hashKey(keyVersion)).update(value, "utf8").digest("hex");
}

export function sealField(keys: SealingKeys, at: string, value: string): SealedValue {
  const s = seal(keys, at, value);
  return {
    $sealed: {
      at,
      ciphertext: b64(s.ciphertext),
      iv: b64(s.iv),
      authTag: b64(s.authTag),
      wrappedDek: b64(s.wrappedDek),
      keyVersion: s.keyVersion,
      hash: fieldHash(keys, value),
      hashKeyVersion: keys.currentVersion,
    },
  };
}

/** The value, opened for where it says it belongs; throws when it was tampered with or moved. */
export function openField(keys: KeyRing, sealed: SealedValue, at: string = sealed.$sealed.at): string {
  const s = sealed.$sealed;
  if (s.at !== at) throw new Error("A sealed value opens only where it belongs");
  return open(keys, at, {
    ciphertext: bytes(s.ciphertext),
    iv: bytes(s.iv),
    authTag: bytes(s.authTag),
    wrappedDek: bytes(s.wrappedDek),
    keyVersion: s.keyVersion,
  });
}

/** Is it the same value as `value`? Without opening it, when its hash's key is still there. */
export function sameField(keys: SealingKeys, sealed: SealedValue, value: string): boolean {
  const s = sealed.$sealed;
  if (keys.versions.includes(s.hashKeyVersion)) return fieldHash(keys, value, s.hashKeyVersion) === s.hash;
  return false;
}

/** Rotation moves it: an older root key version, or wrapped the pre-M64 way. */
export function fieldNeedsRewrap(sealed: SealedValue, toVersion: number): boolean {
  return needsRewrap({ wrappedDek: bytes(sealed.$sealed.wrappedDek), keyVersion: sealed.$sealed.keyVersion }, toVersion);
}

/** Rotation: the data key wrapped for another root key version, the value never opened. The hash stays as it was. */
export function rewrapField(keys: KeyRing, sealed: SealedValue, toVersion: number = keys.currentVersion): SealedValue {
  const s = sealed.$sealed;
  const { wrappedDek, keyVersion } = rewrap(keys, s.at, { wrappedDek: bytes(s.wrappedDek), keyVersion: s.keyVersion }, toVersion);
  return { $sealed: { ...s, wrappedDek: b64(wrappedDek), keyVersion } };
}

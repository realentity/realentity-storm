import { type Transform } from "@realentity/storm-shared";
import sodium from "libsodium-wrappers";

/**
 * Template transforms (M52-T9): `{{x | base64}}` and `{{x | sealedBox: <a reference to a public key>}}`. A plain value
 * is transformed as its reference is resolved; an encrypted field's value only once http.request has opened it, as it
 * sends. Synchronous, so the resolver can apply them: libsodium is loaded first (`transformsReady`, before a run).
 */

let loaded = false;

/** Loads libsodium (WebAssembly) once; every run awaits it before resolving its first reference. */
export async function transformsReady(): Promise<void> {
  if (loaded) return;
  await sodium.ready;
  loaded = true;
}

/** The text as base64 (UTF-8): basic auth, an API that wants its values encoded. */
export function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/**
 * The text sealed to a public key, base64: libsodium's crypto_box_seal (an ephemeral X25519 key, XSalsa20-Poly1305),
 * which only the key's owner opens. GitHub wants a secret's value so, sealed to the repository's key.
 */
export function sealedBox(value: string, publicKey: string): string {
  if (!loaded) throw new Error("sealedBox: libsodium isn't loaded (transformsReady)");
  let key: Uint8Array;
  try {
    key = sodium.from_base64(publicKey.trim(), sodium.base64_variants.ORIGINAL);
  } catch {
    throw new Error("sealedBox: the public key isn't base64");
  }
  if (key.length !== sodium.crypto_box_PUBLICKEYBYTES)
    throw new Error(`sealedBox: a public key is ${sodium.crypto_box_PUBLICKEYBYTES} bytes, not ${key.length}`);
  return sodium.to_base64(sodium.crypto_box_seal(sodium.from_string(value), key), sodium.base64_variants.ORIGINAL);
}

/** The text through each transform in order; `argumentOf` gives a transform's argument as text (resolved already). */
export function applyTransforms(text: string, transforms: readonly Transform[], argumentOf: (t: Transform) => string): string {
  return transforms.reduce((value, t) => {
    if (t.name === "base64") return base64(value);
    if (t.name === "sealedBox") return sealedBox(value, argumentOf(t));
    throw new Error(`There is no transform "${t.name}"`);
  }, text);
}

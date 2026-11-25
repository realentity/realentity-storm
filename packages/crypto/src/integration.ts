import { hkdfSync } from "node:crypto";
import { type Bytes, open, rewrap, seal, type SealedSecret, type SealedSecretBytes } from "./envelope";
import { KeyRing } from "./key-ring";

/**
 * M62: the secrets of the connections Storm itself uses (Integration: the Claude key, a model server's key, later the
 * Telegram bot's token and Google's OAuth secret). Both the api and the worker open them; the user's own secrets
 * (credentials, mail passwords, Google refresh tokens, sealed fields) stay the worker's alone (docs/design.md §7).
 *
 * Kept apart in the cryptography, not only in the code: every root key version gets a key derived for this purpose
 * (HKDF-SHA256, info "storm:integration"), and the AAD is the row id under its own prefix. A credential's ciphertext
 * doesn't open as an integration secret, nor the reverse, even for the same id.
 */
const INFO = "storm:integration";
const AAD_PREFIX = "integration:";

const derived = new WeakMap<KeyRing, KeyRing>();

/** The ring of keys derived for integration secrets, one per root key version. */
export function integrationKeys(keys: KeyRing): KeyRing {
  let ring = derived.get(keys);
  if (!ring) {
    const versions = new Map<number, Buffer>();
    for (const version of keys.versions) {
      versions.set(version, Buffer.from(hkdfSync("sha256", keys.key(version), Buffer.alloc(0), INFO, KeyRing.KEY_BYTES)));
    }
    ring = new KeyRing(versions, keys.currentVersion);
    derived.set(keys, ring);
  }
  return ring;
}

export function sealIntegration(keys: KeyRing, integrationId: string, secret: string): SealedSecretBytes {
  return seal(integrationKeys(keys), AAD_PREFIX + integrationId, secret);
}

export function openIntegration(keys: KeyRing, integrationId: string, sealed: SealedSecret): string {
  return open(integrationKeys(keys), AAD_PREFIX + integrationId, sealed);
}

/** Rotation: the data key re-wrapped with another root key version's derived key; the secret is never decrypted. */
export function rewrapIntegration(
  keys: KeyRing,
  integrationId: string,
  sealed: Pick<SealedSecret, "wrappedDek" | "keyVersion">,
  toVersion: number = keys.currentVersion,
): { wrappedDek: Bytes; keyVersion: number } {
  return rewrap(integrationKeys(keys), AAD_PREFIX + integrationId, sealed, toVersion);
}

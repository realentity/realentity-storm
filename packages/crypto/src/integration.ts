import { type Bytes, open, rewrapSymmetric, sealSymmetric, type SealedSecret, type SealedSecretBytes } from "./envelope";
import { type KeyRing } from "./key-ring";
import { sealKeysOf, type SealingKeys } from "./seal-keys";

/**
 * M62: the secrets of the connections Storm itself uses (Integration: the Claude key, a model server's key, later the
 * Telegram bot's token and Google's OAuth secret). Both the api and the worker open them; the user's own secrets
 * (credentials, mail passwords, Google refresh tokens, sealed fields) stay the worker's alone (docs/design.md §7).
 *
 * Kept apart in the cryptography, not only in the code: every root key version gets a key derived for this purpose
 * (HKDF-SHA256, info "storm:integration"), and the AAD is the row id under its own prefix. A credential's ciphertext
 * doesn't open as an integration secret, nor the reverse, even for the same id. The data key is wrapped with that
 * derived key itself (not to a public key, M64): the api's SealKeys hold it, so the api opens these and only these.
 */
const AAD_PREFIX = "integration:";

/** The ring of keys derived for integration secrets, one per root key version. */
export function integrationKeys(keys: SealingKeys): KeyRing {
  return sealKeysOf(keys).integration;
}

export function sealIntegration(keys: SealingKeys, integrationId: string, secret: string): SealedSecretBytes {
  return sealSymmetric(integrationKeys(keys), AAD_PREFIX + integrationId, secret);
}

export function openIntegration(keys: SealingKeys, integrationId: string, sealed: SealedSecret): string {
  return open(integrationKeys(keys), AAD_PREFIX + integrationId, sealed);
}

/** Rotation: the data key re-wrapped with another root key version's derived key; the secret is never decrypted. */
export function rewrapIntegration(
  keys: KeyRing,
  integrationId: string,
  sealed: Pick<SealedSecret, "wrappedDek" | "keyVersion">,
  toVersion: number = keys.currentVersion,
): { wrappedDek: Bytes; keyVersion: number } {
  return rewrapSymmetric(integrationKeys(keys), AAD_PREFIX + integrationId, sealed, toVersion);
}

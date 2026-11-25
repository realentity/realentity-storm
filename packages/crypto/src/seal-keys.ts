import { createHmac, createPrivateKey, createPublicKey, hkdfSync, type KeyObject } from "node:crypto";
import { KeyRing } from "./key-ring";

/**
 * M64: what sealing needs, and nothing that opens (docs/design.md §7). For each root key version: the X25519 public key
 * the data keys are wrapped to, the integration key (M62, which the api opens the connections' secrets with) and the
 * field-hash key (M52's keyed hashes). All derived from the root key; none of them opens a credential, a mail password,
 * a Google token or a sealed field. The api holds only this; the worker holds the KeyRing, whose derived private keys
 * open what was sealed.
 */
export class SealKeys {
  private constructor(
    readonly currentVersion: number,
    private readonly publicKeys: ReadonlyMap<number, KeyObject>,
    private readonly hashKeys: ReadonlyMap<number, Buffer>,
    /** M62: the keys derived for the connections' secrets (Integration), by root key version. */
    readonly integration: KeyRing,
  ) {}

  private static readonly derived = new WeakMap<KeyRing, SealKeys>();

  /** Derived from the root keys; the root keys aren't kept. */
  static of(keys: KeyRing): SealKeys {
    let sealKeys = SealKeys.derived.get(keys);
    if (!sealKeys) {
      const publicKeys = new Map<number, KeyObject>();
      const hashKeys = new Map<number, Buffer>();
      const integration = new Map<number, Buffer>();
      for (const version of keys.versions) {
        const root = keys.key(version);
        publicKeys.set(version, createPublicKey(sealPrivateKey(root)));
        hashKeys.set(version, createHmac("sha256", root).update("storm:field-hash").digest());
        integration.set(version, derive(root, "storm:integration"));
      }
      sealKeys = new SealKeys(keys.currentVersion, publicKeys, hashKeys, new KeyRing(integration, keys.currentVersion));
      SealKeys.derived.set(keys, sealKeys);
    }
    return sealKeys;
  }

  /** The api's keys: read from the same environment as the KeyRing, which is dropped once they are derived. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): SealKeys {
    return SealKeys.of(KeyRing.fromEnv(env));
  }

  get versions(): number[] {
    return [...this.publicKeys.keys()].sort((a, b) => a - b);
  }

  publicKey(version: number): KeyObject {
    const key = this.publicKeys.get(version);
    if (!key) throw new Error(`Encryption key version ${version} is not configured`);
    return key;
  }

  hashKey(version: number): Buffer {
    const key = this.hashKeys.get(version);
    if (!key) throw new Error(`Encryption key version ${version} is not configured`);
    return key;
  }
}

/** The root keys (the worker) or only what seals (the api). */
export type SealingKeys = KeyRing | SealKeys;

export function sealKeysOf(keys: SealingKeys): SealKeys {
  return keys instanceof SealKeys ? keys : SealKeys.of(keys);
}

function derive(root: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), info, KeyRing.KEY_BYTES));
}

/** PKCS#8 and SPKI headers of a raw X25519 key (RFC 8410). */
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");

/** The X25519 private key the data keys are wrapped to, for a root key version. Only the worker has the root keys. */
export function sealPrivateKey(root: Buffer): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_X25519, derive(root, "storm:seal-x25519")]), format: "der", type: "pkcs8" });
}

/** The raw 32 bytes of a key's public half (given the private key, of its public key). */
export function rawPublicKey(key: KeyObject): Buffer {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  return (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(SPKI_X25519.length);
}

export function publicKeyOfRaw(raw: Uint8Array): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: "der", type: "spki" });
}

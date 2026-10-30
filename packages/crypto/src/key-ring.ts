/** The root keys (KEKs) by version. New secrets are sealed with `currentVersion`; older versions stay readable until rotated. */
export class KeyRing {
  static readonly KEY_BYTES = 32;

  constructor(
    private readonly keys: ReadonlyMap<number, Buffer>,
    readonly currentVersion: number,
  ) {
    if (!keys.has(currentVersion)) {
      throw new Error(`Encryption key version ${currentVersion} is not configured`);
    }
  }

  key(version: number): Buffer {
    const key = this.keys.get(version);
    if (!key) {
      throw new Error(`Encryption key version ${version} is not configured`);
    }
    return key;
  }

  get versions(): number[] {
    return [...this.keys.keys()].sort((a, b) => a - b);
  }

  /**
   * ENCRYPTION_KEY is version 1, ENCRYPTION_KEY_V2, ENCRYPTION_KEY_V3, ... are later versions.
   * ENCRYPTION_KEY_VERSION (default 1) selects the version new secrets are sealed with.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): KeyRing {
    const keys = new Map<number, Buffer>();
    for (const [name, value] of Object.entries(env)) {
      const match = /^ENCRYPTION_KEY(?:_V(\d+))?$/.exec(name);
      if (!match || !value) continue;
      const version = match[1] ? Number(match[1]) : 1;
      keys.set(version, KeyRing.parseKey(value, name));
    }
    const currentVersion = Number(env.ENCRYPTION_KEY_VERSION ?? 1);
    if (!Number.isInteger(currentVersion) || currentVersion < 1) {
      throw new Error("ENCRYPTION_KEY_VERSION must be a positive integer");
    }
    return new KeyRing(keys, currentVersion);
  }

  /** A key of exactly 32 bytes: 64 hex characters (openssl rand -hex 32) or base64 (openssl rand -base64 32). */
  static parseKey(value: string, name = "key"): Buffer {
    const text = value.trim();
    const key = /^[0-9a-fA-F]{64}$/.test(text)
      ? Buffer.from(text, "hex")
      : /^[A-Za-z0-9+/]{43}=$/.test(text)
        ? Buffer.from(text, "base64")
        : null;
    if (!key || key.length !== KeyRing.KEY_BYTES) {
      throw new Error(
        `${name} must be ${KeyRing.KEY_BYTES} bytes: 64 hex characters (openssl rand -hex 32) or base64 (openssl rand -base64 32)`,
      );
    }
    return key;
  }
}

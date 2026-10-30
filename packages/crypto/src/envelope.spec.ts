import { randomBytes } from "node:crypto";
import { open, rewrap, seal, type SealedSecret } from "./envelope";
import { KeyRing } from "./key-ring";

const key = (): Buffer => randomBytes(32);
const ring = (current = 1, versions: Record<number, Buffer> = { 1: key() }): KeyRing =>
  new KeyRing(new Map(Object.entries(versions).map(([v, k]) => [Number(v), k])), current);

const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));

/** Flips one bit of a byte array (copy). */
function flip(bytes: Uint8Array, index = 0): Buffer {
  const copy = Buffer.from(bytes);
  copy[index] = (copy[index] ?? 0) ^ 0x01;
  return copy;
}

describe("envelope encryption", () => {
  const id = "4f6c2a1e-6c1b-4e0a-9a51-2f3c5d7e8a90";

  // M1-U1
  it.each([
    ["ascii", "hunter2"],
    ["cyrillic", "парола-Ж🔑"],
    ["empty", ""],
    ["64 KB", "x".repeat(64 * 1024)],
  ])("round trips %s", (_name, secret) => {
    const keys = ring();
    expect(open(keys, id, seal(keys, id, secret))).toBe(secret);
  });

  // M1-U2
  it("produces a different ciphertext and data key for every seal", () => {
    const keys = ring();
    const a = seal(keys, id, "same");
    const b = seal(keys, id, "same");
    expect(same(a.ciphertext, b.ciphertext)).toBe(false);
    expect(same(a.wrappedDek, b.wrappedDek)).toBe(false);
    expect(same(a.iv, b.iv)).toBe(false);
  });

  it("stores the current key version and a 60-byte wrapped key", () => {
    const keys = ring(2, { 1: key(), 2: key() });
    const sealed = seal(keys, id, "s");
    expect(sealed.keyVersion).toBe(2);
    expect(sealed.wrappedDek).toHaveLength(60);
  });

  // M1-S1
  describe("tampering", () => {
    const keys = ring();
    const sealed = seal(keys, id, "secret value");
    it.each<[string, (s: SealedSecret) => SealedSecret]>([
      ["ciphertext", (s) => ({ ...s, ciphertext: flip(s.ciphertext) })],
      ["authTag", (s) => ({ ...s, authTag: flip(s.authTag) })],
      ["iv", (s) => ({ ...s, iv: flip(s.iv) })],
      ["wrappedDek (iv)", (s) => ({ ...s, wrappedDek: flip(s.wrappedDek, 0) })],
      ["wrappedDek (tag)", (s) => ({ ...s, wrappedDek: flip(s.wrappedDek, 20) })],
      ["wrappedDek (key)", (s) => ({ ...s, wrappedDek: flip(s.wrappedDek, 40) })],
      ["wrappedDek (length)", (s) => ({ ...s, wrappedDek: Buffer.from(s.wrappedDek).subarray(1) })],
    ])("fails when %s is modified", (_field, tamper) => {
      expect(() => open(keys, id, tamper(sealed))).toThrow();
    });
  });

  // M1-S2
  it("fails when the sealed row is moved to another id (AAD)", () => {
    const keys = ring();
    const sealed = seal(keys, id, "secret");
    expect(() => open(keys, "another-row-id", sealed)).toThrow();
  });

  // M1-S3
  it("fails with a wrong root key", () => {
    const sealed = seal(ring(), id, "secret");
    expect(() => open(ring(), id, sealed)).toThrow();
  });

  it("fails when the key version is not configured", () => {
    const keys = ring();
    const sealed = seal(keys, id, "secret");
    expect(() => open(keys, id, { ...sealed, keyVersion: 2 })).toThrow(/version 2 is not configured/);
  });

  it("fails when the key version is wrong", () => {
    const keys = ring(1, { 1: key(), 2: key() });
    const sealed = seal(keys, id, "secret");
    expect(() => open(keys, id, { ...sealed, keyVersion: 2 })).toThrow();
  });

  describe("rewrap", () => {
    it("moves the data key to a new version; the secret then opens with that version only", () => {
      const v1 = key();
      const v2 = key();
      const before = ring(1, { 1: v1 });
      const sealed = seal(before, id, "rotate me");

      const during = ring(2, { 1: v1, 2: v2 });
      const rewrapped = { ...sealed, ...rewrap(during, id, sealed) };
      expect(rewrapped.keyVersion).toBe(2);
      expect(same(rewrapped.ciphertext, sealed.ciphertext)).toBe(true);

      const after = ring(2, { 2: v2 });
      expect(open(after, id, rewrapped)).toBe("rotate me");
      expect(() => open(after, id, sealed)).toThrow();
    });

    it("fails for another row id", () => {
      const keys = ring(2, { 1: key(), 2: key() });
      const sealed = seal(keys, id, "s");
      expect(() => rewrap(keys, "other", sealed)).toThrow();
    });
  });
});

describe("KeyRing.fromEnv", () => {
  const b64 = (): string => randomBytes(32).toString("base64");

  it("reads ENCRYPTION_KEY as version 1 and ENCRYPTION_KEY_V<n> as later versions", () => {
    const keys = KeyRing.fromEnv({ ENCRYPTION_KEY: b64(), ENCRYPTION_KEY_V2: b64(), ENCRYPTION_KEY_VERSION: "2" });
    expect(keys.versions).toEqual([1, 2]);
    expect(keys.currentVersion).toBe(2);
  });

  it("accepts a hex key (openssl rand -hex 32) with the same bytes as its base64 form", () => {
    const raw = randomBytes(32);
    const fromHex = KeyRing.fromEnv({ ENCRYPTION_KEY: raw.toString("hex") });
    const fromBase64 = KeyRing.fromEnv({ ENCRYPTION_KEY: raw.toString("base64") });
    expect(fromHex.key(1).equals(raw)).toBe(true);
    expect(fromBase64.key(1).equals(raw)).toBe(true);
  });

  it("defaults the current version to 1", () => {
    expect(KeyRing.fromEnv({ ENCRYPTION_KEY: b64() }).currentVersion).toBe(1);
  });

  it.each([
    ["missing", {}],
    ["too short", { ENCRYPTION_KEY: randomBytes(16).toString("base64") }],
    ["not base64 of 32 bytes", { ENCRYPTION_KEY: "change-me" }],
    ["current version not configured", { ENCRYPTION_KEY: randomBytes(32).toString("base64"), ENCRYPTION_KEY_VERSION: "2" }],
    ["bad version", { ENCRYPTION_KEY: randomBytes(32).toString("base64"), ENCRYPTION_KEY_VERSION: "x" }],
  ])("rejects %s", (_name, env) => {
    expect(() => KeyRing.fromEnv(env as NodeJS.ProcessEnv)).toThrow();
  });
});

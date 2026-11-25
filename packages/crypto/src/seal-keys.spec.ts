import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import { needsRewrap, open, rewrap, seal, sealSymmetric, wrappedToPublicKey } from "./envelope";
import { integrationKeys, openIntegration, sealIntegration } from "./integration";
import { KeyRing } from "./key-ring";
import { SealKeys } from "./seal-keys";
import { fieldHash, fieldNeedsRewrap, openField, rewrapField, sameField, sealField } from "./sealed-field";

const ring = (current = 1, versions: Record<number, Buffer> = { 1: randomBytes(32) }): KeyRing =>
  new KeyRing(new Map(Object.entries(versions).map(([v, k]) => [Number(v), k])), current);

/** Every Buffer an object holds, however deep (Maps, KeyRings, plain fields). */
function buffersIn(value: unknown, seen = new Set<unknown>()): Buffer[] {
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (Buffer.isBuffer(value)) return [value];
  if (value instanceof Map) return [...value.values()].flatMap((v) => buffersIn(v, seen));
  return Object.values(value as Record<string, unknown>).flatMap((v) => buffersIn(v, seen));
}

// M64: the api seals with SealKeys (public keys, the integration and field-hash keys) and can't open; the worker can.
describe("public-key sealing (M64)", () => {
  const id = "7d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6";
  const otherRow = "1e2f3a4b-5c6d-4e7f-8091-a2b3c4d5e6f7";

  it("seals with SealKeys alone, wrapped to the version's public key; only the root keys open it", () => {
    const keys = ring(2, { 1: randomBytes(32), 2: randomBytes(32) });
    const sealed = seal(SealKeys.of(keys), id, "the mail password");
    expect(sealed.keyVersion).toBe(2);
    expect(sealed.wrappedDek).toHaveLength(92);
    expect(wrappedToPublicKey(sealed)).toBe(true);
    expect(open(keys, id, sealed)).toBe("the mail password");
    // Another root key, another row: no.
    expect(() => open(ring(2, { 1: randomBytes(32), 2: randomBytes(32) }), id, sealed)).toThrow();
    expect(() => open(keys, otherRow, sealed)).toThrow();
  });

  it("the same keys from the environment: the api's SealKeys seal what the worker's KeyRing opens", () => {
    const env = { ENCRYPTION_KEY: randomBytes(32).toString("hex") };
    expect(open(KeyRing.fromEnv(env), id, seal(SealKeys.fromEnv(env), id, "x"))).toBe("x");
  });

  it("holds no root key and has nothing that opens", () => {
    const root = randomBytes(32);
    const sealKeys = SealKeys.of(ring(1, { 1: root }));
    expect(buffersIn(sealKeys).some((b) => b.equals(root))).toBe(false);
    expect((sealKeys as unknown as { key?: unknown }).key).toBeUndefined();
    // Its secret keys (integration, field hash) aren't keys for the user's secrets either.
    const sealed = seal(sealKeys, id, "x");
    for (const candidate of buffersIn(sealKeys)) {
      if (candidate.length !== 32) continue;
      expect(() => open(ring(1, { 1: candidate }), id, sealed)).toThrow();
    }
  });

  it("refuses a tampered wrapping and a low-order ephemeral key", () => {
    const keys = ring();
    const sealed = seal(keys, id, "x");
    const tampered = Buffer.from(sealed.wrappedDek);
    tampered[40] = (tampered[40] ?? 0) ^ 1;
    expect(() => open(keys, id, { ...sealed, wrappedDek: tampered })).toThrow();
    // A forger without the public key: an all-zero point would give a secret anyone knows.
    const lowOrder = Buffer.concat([Buffer.alloc(32), Buffer.from(sealed.wrappedDek).subarray(32)]);
    expect(() => open(keys, id, { ...sealed, wrappedDek: lowOrder })).toThrow("Malformed wrapped data key");
    expect(() => open(keys, id, { ...sealed, wrappedDek: Buffer.alloc(70) })).toThrow("Malformed wrapped data key");
  });

  it("keeps opening what was sealed before (the root key wraps it); rotation moves it to the public key", () => {
    const keys = ring();
    const before = sealSymmetric(keys, id, "an old credential");
    expect(before.wrappedDek).toHaveLength(60);
    expect(open(keys, id, before)).toBe("an old credential");
    expect(needsRewrap(before, 1)).toBe(true);

    const moved = { ...before, ...rewrap(keys, id, before, 1) };
    expect(wrappedToPublicKey(moved)).toBe(true);
    expect(needsRewrap(moved, 1)).toBe(false);
    expect(open(keys, id, moved)).toBe("an old credential");
    expect(Buffer.from(moved.ciphertext).equals(Buffer.from(before.ciphertext))).toBe(true);
  });

  it("sealed fields: hashed as before, sealed by SealKeys, opened by the root keys, moved by rotation", () => {
    const root = randomBytes(32);
    const keys = ring(1, { 1: root });
    // The hash key is the one fields were always hashed with: existing hashes still match.
    const hashKey = createHmac("sha256", root).update("storm:field-hash").digest();
    expect(fieldHash(SealKeys.of(keys), "IBAN")).toBe(createHmac("sha256", hashKey).update("IBAN").digest("hex"));

    const at = "app:a/Account:k/iban";
    const sealed = sealField(SealKeys.of(keys), at, "BG80BNBG96611020345678");
    expect(openField(keys, sealed)).toBe("BG80BNBG96611020345678");
    expect(sameField(SealKeys.of(keys), sealed, "BG80BNBG96611020345678")).toBe(true);
    expect(fieldNeedsRewrap(sealed, 1)).toBe(false);

    const next = ring(2, { 1: root, 2: randomBytes(32) });
    const rotated = rewrapField(next, sealed, 2);
    expect(fieldNeedsRewrap(rotated, 2)).toBe(false);
    expect(openField(next, rotated)).toBe("BG80BNBG96611020345678");
  });

  it("integration secrets: the same derived key as M62, which SealKeys open too", () => {
    const root = randomBytes(32);
    const keys = ring(1, { 1: root });
    const derived = Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), "storm:integration", 32));
    expect(integrationKeys(SealKeys.of(keys)).key(1).equals(derived)).toBe(true);
    const sealed = sealIntegration(keys, id, "sk-ant-made-up");
    expect(sealed.wrappedDek).toHaveLength(60);
    expect(openIntegration(SealKeys.of(keys), id, sealed)).toBe("sk-ant-made-up");
    expect(openIntegration(keys, id, sealIntegration(SealKeys.of(keys), id, "token"))).toBe("token");
  });
});

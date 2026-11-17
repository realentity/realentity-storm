import { isSealed, maskSealed, sealedAt } from "@realentity/storm-shared";
import { randomBytes } from "node:crypto";
import { KeyRing } from "./key-ring";
import { fieldHash, openField, rewrapField, sameField, sealField } from "./sealed-field";

const ring = (current = 1, versions: Record<number, Buffer> = { 1: randomBytes(32) }): KeyRing =>
  new KeyRing(new Map(Object.entries(versions).map(([v, k]) => [Number(v), k])), current);

describe("sealed fields (M52-T2)", () => {
  const at = sealedAt("4f6c2a1e-6c1b-4e0a-9a51-2f3c5d7e8a90", "Secret", "API_TOKEN", "value");

  it("seals a value for where it belongs and opens it there only", () => {
    const keys = ring();
    const sealed = sealField(keys, at, "s3cret");
    expect(isSealed(sealed)).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain("s3cret");
    expect(openField(keys, sealed)).toBe("s3cret");
    expect(() => openField(keys, sealed, sealedAt("other", "Secret", "API_TOKEN", "value"))).toThrow("only where it belongs");
    // Moved by hand to another entity: the AAD no longer matches
    expect(() => openField(keys, { $sealed: { ...sealed.$sealed, at: sealedAt("x", "Secret", "OTHER", "value") } })).toThrow();
  });

  it("hashes the same value the same, under a key: a changed value shows without opening it", () => {
    const keys = ring();
    const a = sealField(keys, at, "one");
    expect(sealField(keys, at, "one").$sealed.hash).toBe(a.$sealed.hash);
    expect(sealField(keys, at, "two").$sealed.hash).not.toBe(a.$sealed.hash);
    expect(sameField(keys, a, "one")).toBe(true);
    expect(sameField(keys, a, "two")).toBe(false);
    expect(fieldHash(ring(), "one")).not.toBe(a.$sealed.hash);
  });

  it("rewraps to a new root key without changing the value or its hash", () => {
    const v1 = randomBytes(32);
    const keys = ring(2, { 1: v1, 2: randomBytes(32) });
    const old = sealField(ring(1, { 1: v1 }), at, "s3cret");
    const moved = rewrapField(keys, old);
    expect(moved.$sealed.keyVersion).toBe(2);
    expect(moved.$sealed.hash).toBe(old.$sealed.hash);
    expect(openField(ring(2, { 2: keys.key(2) }), moved)).toBe("s3cret");
  });

  it("masks every sealed value in what is shown", () => {
    const sealed = sealField(ring(), at, "s3cret");
    expect(maskSealed({ items: [{ name: "API_TOKEN", value: sealed }], n: 1 })).toEqual({
      items: [{ name: "API_TOKEN", value: "***" }],
      n: 1,
    });
  });
});

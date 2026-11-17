import {
  fromSealedToken,
  holdsSealed,
  isSealed,
  maskSealed,
  parseReference,
  referencePaths,
  SEALED_TOKEN,
  sealedAt,
  sealedToken,
  tokenTransforms,
  unmaskEdit,
} from "@realentity/storm-shared";
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

describe("handles in text and gate edits (M52-T5, T8)", () => {
  const at = sealedAt("4f6c2a1e-6c1b-4e0a-9a51-2f3c5d7e8a90", "Secret", "API_TOKEN", "value");
  const keys = ring();
  const sealed = sealField(keys, at, "s3cret");

  it("carries a handle in text as a token, shown as ***", () => {
    const text = `Bearer ${sealedToken(sealed)}`;
    expect(text).not.toContain("s3cret");
    const [, encoded] = new RegExp(SEALED_TOKEN.source).exec(text)!;
    expect(fromSealedToken(encoded)).toEqual(sealed);
    expect(fromSealedToken("not-a-token")).toBeNull();
    expect(maskSealed({ headers: { Authorization: text } })).toEqual({ headers: { Authorization: "Bearer ***" } });
    expect(holdsSealed(text)).toBe(true);
  });

  it("puts the handles back where a gate edit still shows ***", () => {
    const token = sealedToken(sealed);
    const original = { body: { value: sealed, note: "x" }, headers: { Authorization: `Bearer ${token}` } };
    // Shown masked, the note edited: the handle and the token stay.
    expect(unmaskEdit(original, { body: { value: "***", note: "y" }, headers: { Authorization: "Bearer ***" } })).toEqual({
      body: { value: sealed, note: "y" },
      headers: { Authorization: `Bearer ${token}` },
    });
    // Replaced by the user: theirs.
    expect(unmaskEdit(original, { body: { value: "typed", note: "x" }, headers: { Authorization: "Basic abc" } })).toEqual({
      body: { value: "typed", note: "x" },
      headers: { Authorization: "Basic abc" },
    });
  });
});

describe("transforms in references and tokens (M52-T9)", () => {
  it("reads a reference's path, its transforms and every path it uses", () => {
    expect(parseReference("item.value | sealedBox: key.json.key | base64")).toEqual({
      path: "item.value",
      transforms: [{ name: "sealedBox", argument: "key.json.key" }, { name: "base64" }],
    });
    expect(parseReference("cred:github")).toEqual({ path: "cred:github", transforms: [] });
    expect(referencePaths("item.value | sealedBox: key.json.key")).toEqual(["item.value", "key.json.key"]);
  });

  it("carries a handle's transforms in its token, their arguments as they were", () => {
    const sealed = sealField(ring(), sealedAt("a", "Secret", "X", "value"), "s3cret");
    const token = sealedToken(sealed, [{ name: "sealedBox", argument: "q+/Key==" }, { name: "base64" }]);
    const [, encoded, transforms] = new RegExp(SEALED_TOKEN.source).exec(token)!;
    expect(fromSealedToken(encoded)).toEqual(sealed);
    expect(tokenTransforms(transforms)).toEqual([{ name: "sealedBox", argument: "q+/Key==" }, { name: "base64" }]);
    expect(maskSealed(`x ${token} y`)).toBe("x *** y");
  });
});

import sodium from "libsodium-wrappers";
import { applyTransforms, base64, sealedBox, transformsReady } from "./transforms";

describe("template transforms (M52-T9)", () => {
  beforeAll(transformsReady);

  it("base64 encodes UTF-8", () => {
    expect(base64("user:pässword")).toBe(Buffer.from("user:pässword", "utf8").toString("base64"));
    expect(base64("")).toBe("");
  });

  it("sealedBox seals to the key: only its secret key opens it, and never twice the same", () => {
    const { publicKey, privateKey } = sodium.crypto_box_keypair();
    const key = sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL);
    const sealed = sealedBox("s3cret-value", key);
    const opened = sodium.crypto_box_seal_open(sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL), publicKey, privateKey);
    expect(sodium.to_string(opened)).toBe("s3cret-value");
    expect(sealedBox("s3cret-value", key)).not.toBe(sealed);
    expect(sealed).not.toContain("s3cret");
  });

  it("refuses a key that isn't one", () => {
    expect(() => sealedBox("x", "not base64!")).toThrow("isn't base64");
    expect(() => sealedBox("x", Buffer.alloc(16).toString("base64"))).toThrow("32 bytes, not 16");
  });

  it("applies transforms in order", () => {
    expect(applyTransforms("a:b", [{ name: "base64" }, { name: "base64" }], () => "")).toBe(base64(base64("a:b")));
    expect(() => applyTransforms("a", [{ name: "rot13" }], () => "")).toThrow('There is no transform "rot13"');
  });
});

import { randomBytes } from "node:crypto";
import { open, seal } from "./envelope";
import { integrationKeys, openIntegration, rewrapIntegration, sealIntegration } from "./integration";
import { KeyRing } from "./key-ring";

const ring = (current = 1, versions: Record<number, Buffer> = { 1: randomBytes(32) }): KeyRing =>
  new KeyRing(new Map(Object.entries(versions).map(([v, k]) => [Number(v), k])), current);

// M62-S1: the connections' secrets apart from the user's, in the cryptography
describe("integration secrets", () => {
  const id = "0b9e3c4d-5f61-4a7b-8c9d-0e1f2a3b4c5d";
  const otherRow = "1c0f4d5e-6a72-4b8c-9dae-1f2a3b4c5d6e";

  it("round trips, and only for its own row", () => {
    const keys = ring();
    const sealed = sealIntegration(keys, id, "sk-ant-made-up");
    expect(openIntegration(keys, id, sealed)).toBe("sk-ant-made-up");
    expect(() => openIntegration(keys, otherRow, sealed)).toThrow();
  });

  it("doesn't open as a credential, and a credential doesn't open as it, even for the same id", () => {
    const keys = ring();
    expect(() => open(keys, id, sealIntegration(keys, id, "token"))).toThrow();
    expect(() => openIntegration(keys, id, seal(keys, id, "password"))).toThrow();
  });

  it("derives a key of its own per root key version, and rotates without decrypting", () => {
    const keys = ring(1, { 1: randomBytes(32), 2: randomBytes(32) });
    const derived = integrationKeys(keys);
    expect(derived.versions).toEqual([1, 2]);
    expect(derived.key(1).equals(keys.key(1))).toBe(false);
    expect(integrationKeys(keys)).toBe(derived);

    const sealed = sealIntegration(keys, id, "bot-token");
    const moved = { ...sealed, ...rewrapIntegration(keys, id, sealed, 2) };
    expect(moved.keyVersion).toBe(2);
    expect(openIntegration(keys, id, moved)).toBe("bot-token");
  });
});

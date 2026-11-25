import { KeyRing, open, SealKeys, wrappedToPublicKey } from "@realentity/storm-crypto";
import { createPrismaConnection, Integrations, type PrismaConnection } from "@realentity/storm-db";
import { type CredentialView } from "@realentity/storm-shared";
import type request from "supertest";
import { createTestApp, type TestApp } from "./support/test-app";

/** Every Buffer an object holds, however deep. */
function buffersIn(value: unknown, seen = new Set<unknown>()): Buffer[] {
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (Buffer.isBuffer(value)) return [value];
  if (value instanceof Map) return [...value.values()].flatMap((v) => buffersIn(v, seen));
  return Object.values(value as Record<string, unknown>).flatMap((v) => buffersIn(v, seen));
}

// M64-S1: the api seals and can't open. It holds SealKeys (public keys, the integration and field-hash keys), never the
// root keys; what it seals opens with the worker's keys only.
describe("the api seals, and holds no key that opens", () => {
  let api: TestApp;
  let agent: ReturnType<typeof request.agent>;
  let db: PrismaConnection;

  beforeAll(async () => {
    api = await createTestApp();
    agent = await api.signedIn();
    db = createPrismaConnection();
  });

  afterAll(async () => {
    await db.client.credential.deleteMany({ where: { name: "seal-only" } });
    await db.close();
    await api.close();
  });

  it("has no KeyRing to inject, only SealKeys, which hold no root key", () => {
    expect(() => api.app.get(KeyRing, { strict: false })).toThrow();
    const sealKeys = api.app.get(SealKeys, { strict: false });
    expect(sealKeys).toBeInstanceOf(SealKeys);
    const roots = KeyRing.fromEnv(process.env);
    const held = [...buffersIn(sealKeys), ...buffersIn(api.app.get(Integrations, { strict: false }))];
    for (const version of roots.versions) expect(held.some((b) => b.equals(roots.key(version)))).toBe(false);
  });

  it("a credential it saves is wrapped to the public key, and opens with the worker's keys, not with anything it holds", async () => {
    const view = (
      await agent
        .post("/api/credentials")
        .send({ name: "seal-only", allowedHosts: ["example.com"], kind: "PASSWORD", secret: "made-up-password-42" })
        .expect(201)
    ).body as CredentialView;
    const row = await db.client.credential.findUniqueOrThrow({ where: { credentialId: view.credentialId } });
    expect(wrappedToPublicKey(row)).toBe(true);
    expect(open(KeyRing.fromEnv(process.env), row.credentialId, row)).toBe("made-up-password-42");
    // The api's own key material, tried as root keys: none opens it.
    for (const candidate of buffersIn(api.app.get(SealKeys, { strict: false }))) {
      if (candidate.length !== 32) continue;
      expect(() => open(new KeyRing(new Map([[row.keyVersion, candidate]]), row.keyVersion), row.credentialId, row)).toThrow();
    }
  });
});

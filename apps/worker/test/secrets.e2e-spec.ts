import { KeyRing, open, openIntegration, SealKeys, seal, sealIntegration, sealSymmetric, wrappedToPublicKey } from "@realentity/storm-crypto";
import { createPrismaConnection, type PrismaConnection } from "@realentity/storm-db";
import { TestEnvironment } from "@realentity/storm-testing";
import { Test } from "@nestjs/testing";
import { randomBytes, randomUUID } from "node:crypto";
import { checkCredentials } from "../src/secrets/credential-check";
import { CredentialHostMismatchError, CredentialNotFoundError, CredentialVault } from "../src/secrets/credential-vault";
import { KeyRotation } from "../src/secrets/key-rotation";
import { WorkerModule } from "../src/worker.module";

const ring = (current: number, keys: Record<number, Buffer>): KeyRing =>
  new KeyRing(new Map(Object.entries(keys).map(([v, k]) => [Number(v), k])), current);

describe("worker secrets", () => {
  let db: PrismaConnection;
  let userId: string;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  afterEach(async () => {
    await db.client.credential.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  async function insert(keys: KeyRing | SealKeys, name: string, secret: string, allowedHosts = ["example.com"]): Promise<string> {
    const credentialId = randomUUID();
    await db.client.credential.create({
      data: { credentialId, userId, name, allowedHosts, kind: "PASSWORD", username: "me", ...seal(keys, credentialId, secret) },
    });
    return credentialId;
  }

  describe("CredentialVault", () => {
    const keys = ring(1, { 1: randomBytes(32) });
    const vault = (): CredentialVault => new CredentialVault(db.client, keys);

    // M50: through the run's slot, bound by id; never by the credential's name
    it("reveals the credential bound to a slot on an allowed host and records the use", async () => {
      const id = await insert(keys, "site", "s3cret", ["example.com", "*.example.com"]);
      await expect(vault().revealFor({ userId, credentials: { login: id } }, "login", "login.example.com")).resolves.toEqual({ username: "me", secret: "s3cret" });
      // Its name is no way in.
      await expect(vault().revealFor({ userId, credentials: {} }, "site", "login.example.com")).rejects.toBeInstanceOf(CredentialNotFoundError);
      const row = await db.client.credential.findUniqueOrThrow({ where: { credentialId: id } });
      expect(row.lastUsedAt).not.toBeNull();
    });

    // M8-S1 (binding part): never fills on a host outside allowedHosts
    it.each(["example.com.evil.net", "evil-example.com", "example.org"])("refuses %s", async (host) => {
      const id = await insert(keys, "site", "s3cret", ["example.com", "*.example.com"]);
      await expect(vault().revealFor({ userId, credentials: { login: id } }, "login", host)).rejects.toBeInstanceOf(CredentialHostMismatchError);
    });

    it("reports a slot without a credential, and one bound to another user's", async () => {
      await expect(vault().revealFor({ userId, credentials: {} }, "nope", "example.com")).rejects.toThrow('"nope" has no credential');
      const id = await insert(keys, "site", "s3cret");
      await expect(vault().revealFor({ userId: randomUUID(), credentials: { login: id } }, "login", "example.com")).rejects.toBeInstanceOf(CredentialNotFoundError);
    });
  });

  // M1-I1
  describe("KeyRotation", () => {
    it("re-wraps every row to the new version; all secrets then open with the new key only", async () => {
      const v1 = randomBytes(32);
      const v2 = randomBytes(32);
      const before = ring(1, { 1: v1 });
      const secrets = new Map<string, string>();
      for (let i = 0; i < 205; i++) {
        const secret = `secret-${i}-${randomUUID()}`;
        secrets.set(await insert(before, `c${i}`, secret), secret);
      }

      const result = await new KeyRotation(db.client, ring(2, { 1: v1, 2: v2 })).run();
      expect(result).toEqual({ rewrapped: 205, skipped: 0, fromVersions: [1], toVersion: 2 });

      const onlyV2 = ring(2, { 2: v2 });
      const rows = await db.client.credential.findMany();
      expect(rows.every((row) => row.keyVersion === 2)).toBe(true);
      for (const row of rows) {
        expect(open(onlyV2, row.credentialId, row)).toBe(secrets.get(row.credentialId));
      }

      const again = await new KeyRotation(db.client, ring(2, { 1: v1, 2: v2 })).run();
      expect(again.rewrapped).toBe(0);
    });

    // M64-T3: what was sealed before M64 (the data key wrapped with the root key itself) moves to the version's public key,
    // even at the current version; the integrations stay wrapped with their derived key (the api opens them).
    it("moves pre-M64 secrets to the public key at the same version, and leaves the integrations as they are", async () => {
      const v1 = randomBytes(32);
      const keys = ring(1, { 1: v1 });
      const legacy = randomUUID();
      await db.client.credential.create({
        data: { credentialId: legacy, userId, name: "legacy", allowedHosts: ["example.com"], kind: "PASSWORD", username: "me", ...sealSymmetric(keys, legacy, "old-password") },
      });
      const current = await insert(SealKeys.of(keys), "current", "new-password");
      const integrationId = randomUUID();
      await db.client.integration.create({
        data: { integrationId, userId, kind: "CLAUDE", name: "Claude", ...sealIntegration(keys, integrationId, "sk-ant-made-up-key") },
      });
      try {
        const result = await new KeyRotation(db.client, keys).run();
        expect(result).toEqual({ rewrapped: 1, skipped: 0, fromVersions: [1], toVersion: 1 });
        const moved = await db.client.credential.findUniqueOrThrow({ where: { credentialId: legacy } });
        expect(wrappedToPublicKey(moved)).toBe(true);
        expect(open(keys, legacy, moved)).toBe("old-password");
        const untouched = await db.client.credential.findUniqueOrThrow({ where: { credentialId: current } });
        expect(open(keys, current, untouched)).toBe("new-password");
        const integration = await db.client.integration.findUniqueOrThrow({ where: { integrationId } });
        expect(integration.wrappedDek).toHaveLength(60);
        expect((await new KeyRotation(db.client, keys).run()).rewrapped).toBe(0);
      } finally {
        await db.client.integration.deleteMany({ where: { integrationId } });
      }
    });

    // M62: the integrations' secrets (the Claude key, a model server's) under their own derived key
    it("re-wraps the integrations' secrets too, and they open with the new key only", async () => {
      const v1 = randomBytes(32);
      const v2 = randomBytes(32);
      const integrationId = randomUUID();
      await db.client.integration.create({
        data: { integrationId, userId, kind: "CLAUDE", name: "Claude", ...sealIntegration(ring(1, { 1: v1 }), integrationId, "sk-ant-made-up-key") },
      });
      try {
        const result = await new KeyRotation(db.client, ring(2, { 1: v1, 2: v2 })).run();
        expect(result).toMatchObject({ rewrapped: 1, fromVersions: [1], toVersion: 2 });
        const row = await db.client.integration.findUniqueOrThrow({ where: { integrationId } });
        expect(row.keyVersion).toBe(2);
        const sealed = { ciphertext: row.ciphertext!, iv: row.iv!, authTag: row.authTag!, wrappedDek: row.wrappedDek!, keyVersion: row.keyVersion! };
        expect(openIntegration(ring(2, { 2: v2 }), integrationId, sealed)).toBe("sk-ant-made-up-key");
      } finally {
        await db.client.integration.deleteMany({ where: { integrationId } });
      }
    });
  });

  // M5-I1 (the check the restore drill runs)
  it("checks that every credential opens with the key, naming the ones that don't", async () => {
    const key = randomBytes(32);
    await insert(ring(1, { 1: key }), "mail", "app-password");
    await insert(ring(1, { 1: key }), "site", "s3cret");
    await expect(checkCredentials(db.client, ring(1, { 1: key }))).resolves.toEqual({ ok: ["mail", "site"], failed: [] });
    await expect(checkCredentials(db.client, ring(1, { 1: randomBytes(32) }))).resolves.toEqual({
      ok: [],
      failed: [
        { name: "mail", keyVersion: 1 },
        { name: "site", keyVersion: 1 },
      ],
    });
  });

  it("boots the worker module with the environment's key ring", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const keys = KeyRing.fromEnv(process.env);
    const id = await insert(keys, "boot", "value");
    await expect(app.get(CredentialVault).revealFor({ userId, credentials: { boot: id } }, "boot", "example.com")).resolves.toMatchObject({ secret: "value" });
    await app.close();
  });
});

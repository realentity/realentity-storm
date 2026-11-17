import { KeyRing, openField, sealField } from "@realentity/storm-crypto";
import { createPrismaConnection, type Prisma, type PrismaConnection } from "@realentity/storm-db";
import { isSealed, sealedAt, type SealedValue } from "@realentity/storm-shared";
import { defaultCatalog } from "@realentity/storm-steps";
import { TestEnvironment } from "@realentity/storm-testing";
import { randomBytes, randomUUID } from "node:crypto";
import { NO_ATTENTION, type StepContext } from "../src/runner/step-executor";
import { checkCredentials } from "../src/secrets/credential-check";
import { CredentialVault } from "../src/secrets/credential-vault";
import { KeyRotation } from "../src/secrets/key-rotation";
import { SaveStep } from "../src/steps/data-steps";
import { ReadStep } from "../src/steps/entity-steps";

jest.setTimeout(60_000);

const SECRETS = `
name: Secrets
types:
  Secret:
    key: name
    fields:
      name: { type: text, required: true }
      value: { type: text, encrypted: true }
      note: { type: text }
`;

const ring = (current: number, keys: Record<number, Buffer>): KeyRing =>
  new KeyRing(new Map(Object.entries(keys).map(([v, k]) => [Number(v), k])), current);

type Saved = { added: Record<string, unknown>[]; changed: { key: string }[]; invalid: { problems: string[] }[] };

// M52-I1 (worker part), I2: data.save seals an encrypted field, data.read gives it as a handle, rotation re-wraps it
describe("encrypted fields in pipelines", () => {
  const catalog = defaultCatalog();
  const v1 = randomBytes(32);
  const keys = ring(1, { 1: v1 });
  let db: PrismaConnection;
  let userId: string;
  let appId: string;

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
  });

  beforeEach(async () => {
    const app = await db.client.app.create({ data: { userId, name: "Secrets" } });
    const version = await db.client.appVersion.create({ data: { appId: app.appId, version: 1, definition: {}, source: SECRETS } });
    await db.client.app.update({ where: { appId: app.appId }, data: { currentVersionId: version.appVersionId } });
    appId = app.appId;
  });

  afterEach(async () => {
    await db.client.app.deleteMany();
  });

  afterAll(async () => {
    await db.close();
  });

  const context = (): StepContext => ({
    runId: randomUUID(),
    userId,
    pipelineId: randomUUID(),
    stepId: "s",
    stepKey: "save",
    itemIndex: null,
    dryRun: false,
    app: "Secrets",
    recordUsage: () => undefined,
    attention: NO_ATTENTION,
  });
  const vault = (k: KeyRing = keys) => new CredentialVault(db.client, k);
  const save = (items: Record<string, unknown>[], k: KeyRing = keys) =>
    new SaveStep(db.client, undefined, vault(k)).execute(
      catalog.get("data.save")!.input.parse({ type: "Secret", items }),
      context(),
    ) as Promise<Saved>;
  const read = () =>
    new ReadStep(db.client).execute(catalog.get("data.read")!.input.parse({ type: "Secret" }), context()) as Promise<{
      items: Record<string, unknown>[];
    }>;
  const stored = async (key: string) =>
    (await db.client.dataEntity.findUniqueOrThrow({ where: { appId_type_key: { appId, type: "Secret", key } } })).value as Record<
      string,
      unknown
    >;

  it("seals the value: the row holds no text, and only its place opens it", async () => {
    await save([{ name: "API_TOKEN", value: "s3cret-token", note: "for the deploy" }]);
    const value = await stored("API_TOKEN");
    expect(JSON.stringify(value)).not.toContain("s3cret-token");
    expect(value.note).toBe("for the deploy");
    expect(isSealed(value.value)).toBe(true);
    expect(openField(keys, value.value as SealedValue, sealedAt(appId, "Secret", "API_TOKEN", "value"))).toBe("s3cret-token");
  });

  it("tells a change only when the value changed, and keeps it when a save doesn't give it", async () => {
    await save([{ name: "API_TOKEN", value: "one" }]);
    const first = await stored("API_TOKEN");
    expect((await save([{ name: "API_TOKEN", value: "one" }])).changed).toEqual([]);
    expect((await stored("API_TOKEN")).value).toEqual(first.value);
    expect((await save([{ name: "API_TOKEN", note: "re-read" }])).changed.map((c) => c.key)).toEqual(["API_TOKEN"]);
    expect((await stored("API_TOKEN")).value).toEqual(first.value);
    expect((await save([{ name: "API_TOKEN", value: "two" }])).changed.map((c) => c.key)).toEqual(["API_TOKEN"]);
    expect(openField(keys, (await stored("API_TOKEN")).value as SealedValue)).toBe("two");
  });

  it("reads it as a handle; a handle saved under another entity is sealed again for it", async () => {
    await save([{ name: "API_TOKEN", value: "s3cret" }]);
    const [item] = (await read()).items;
    expect(isSealed(item.value)).toBe(true);
    await save([{ name: "COPY", value: item.value }]);
    const copy = (await stored("COPY")).value as SealedValue;
    expect(copy.$sealed.at).toBe(sealedAt(appId, "Secret", "COPY", "value"));
    expect(openField(keys, copy)).toBe("s3cret");
  });

  it("leaves out a handle under a field that isn't encrypted, and one copied in the database", async () => {
    await save([{ name: "API_TOKEN", value: "s3cret" }]);
    const handle = (await read()).items[0].value;
    const saved = await save([{ name: "LEAK", note: handle }]);
    expect(saved.invalid[0].problems).toEqual(["note is an encrypted value: only an encrypted field keeps it"]);
    // Copied by hand from one row to another: data.read doesn't give it.
    await db.client.dataEntity.create({ data: { appId, type: "Secret", key: "MOVED", value: { name: "MOVED", value: handle as object } } });
    const moved = (await read()).items.find((i) => i.name === "MOVED");
    expect(moved).toEqual({ name: "MOVED" });
  });

  it("is re-wrapped by key rotation and opened by storm check", async () => {
    await save([{ name: "API_TOKEN", value: "s3cret" }]);
    const both = ring(2, { 1: v1, 2: randomBytes(32) });
    const result = await new KeyRotation(db.client, both).run();
    expect(result.rewrapped).toBeGreaterThanOrEqual(1);
    const rewrapped = (await stored("API_TOKEN")).value as SealedValue;
    expect(rewrapped.$sealed.keyVersion).toBe(2);
    expect(openField(ring(2, { 2: both.key(2) }), rewrapped)).toBe("s3cret");
    expect((await checkCredentials(db.client, both)).ok).toContain("1 encrypted field");
    // A value sealed for another key fails the check, named by where it is.
    await db.client.dataEntity.create({
      data: {
        appId,
        type: "Secret",
        key: "OTHER",
        value: {
          name: "OTHER",
          value: sealField(
            ring(1, { 1: randomBytes(32) }),
            sealedAt(appId, "Secret", "OTHER", "value"),
            "x",
          ) as unknown as Prisma.InputJsonObject,
        },
      },
    });
    expect((await checkCredentials(db.client, both)).failed).toContainEqual({ name: "Secret OTHER: value", keyVersion: 1 });
  });
});

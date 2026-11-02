import { KeyRing, seal } from "@ai-me/crypto";
import { createPrismaConnection, type PrismaConnection } from "@ai-me/db";
import { defaultCatalog, PipelineCompiler } from "@ai-me/steps";
import { TestEnvironment } from "@ai-me/testing";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PipelineRunner } from "../src/runner/pipeline-runner";
import { ExecutorRegistry, NO_ATTENTION, type StepContext } from "../src/runner/step-executor";
import { CredentialVault } from "../src/secrets/credential-vault";
import { SaveStep } from "../src/steps/data-steps";
import { DbQueryStep } from "../src/steps/db-step";
import { HistoryStep } from "../src/steps/history-step";
import { AlertStep } from "../src/steps/map-alert-steps";
import { Counting, createVersion } from "./support/test-steps";

/** The test database, its own schema in the search_path: "my app's database" for these tests. */
function appDatabase(options = "-c search_path=m29app"): { url: string; host: string; password: string } {
  const url = new URL(process.env.DATABASE_URL!);
  url.search = "";
  url.searchParams.set("options", options);
  return { url: url.href, host: url.hostname.toLowerCase(), password: decodeURIComponent(url.password) };
}

// M29-T7
describe("M29: db.query", () => {
  let db: PrismaConnection;
  let userId: string;
  let step: DbQueryStep;
  const keys = KeyRing.fromEnv(process.env);
  const app = appDatabase();

  const store = async (name: string, secret: string, allowedHosts: string[], kind: "DATABASE" | "API_KEY" = "DATABASE") => {
    const credentialId = randomUUID();
    await db.client.credential.create({ data: { credentialId, userId, name, kind, allowedHosts, ...seal(keys, credentialId, secret) } });
  };

  beforeAll(async () => {
    db = createPrismaConnection();
    userId = (await db.client.user.findUniqueOrThrow({ where: { email: TestEnvironment.ADMIN_EMAIL } })).userId;
    await db.client.$executeRawUnsafe("DROP SCHEMA IF EXISTS m29app CASCADE");
    await db.client.$executeRawUnsafe("CREATE SCHEMA m29app");
    await db.client.$executeRawUnsafe("CREATE TABLE m29app.orders (id serial PRIMARY KEY, item text NOT NULL, placed timestamptz NOT NULL DEFAULT '2026-11-02T08:00:00Z', total bigint NOT NULL DEFAULT 10)");
    await db.client.$executeRawUnsafe("CREATE TABLE m29app.users (id serial PRIMARY KEY)");
  });

  beforeEach(async () => {
    await db.client.$executeRawUnsafe("TRUNCATE m29app.orders, m29app.users RESTART IDENTITY");
    await db.client.$executeRawUnsafe("INSERT INTO m29app.orders (item) VALUES ('tea'), ('coffee'), ('cake')");
    await store("app-db", app.url, [app.host]);
    step = new DbQueryStep(new CredentialVault(db.client, keys));
  });

  afterEach(async () => {
    await db.client.run.deleteMany();
    await db.client.pipeline.deleteMany();
    await db.client.credential.deleteMany();
    await db.client.dataPoint.deleteMany();
    await db.client.dataRecord.deleteMany();
  });

  afterAll(async () => {
    await db.client.$executeRawUnsafe("DROP SCHEMA IF EXISTS m29app CASCADE");
    await db.close();
  });

  const context = (): StepContext => ({
    runId: "00000000-0000-4000-8000-000000000001",
    userId,
    pipelineId: "00000000-0000-4000-8000-000000000002",
    stepId: "s",
    stepKey: "k",
    itemIndex: null,
    dryRun: false,
    recordUsage: () => undefined,
    attention: NO_ATTENTION,
  });
  type Output = { items: Record<string, unknown>[]; rows: number; truncated: boolean; columns: string[] };
  const query = (raw: Record<string, unknown>) =>
    step.execute(defaultCatalog().get("db.query")!.input.parse({ connection: "{{cred:app-db}}", ...raw }), context()) as Promise<Output>;

  it("M29-I7: rows as items (counts as numbers, dates as text), values as $1, at most maxRows", async () => {
    expect(await query({ sql: "SELECT id, item, placed, total FROM orders WHERE item <> $1 ORDER BY id", params: ["cake"] })).toEqual({
      items: [
        { id: 1, item: "tea", placed: "2026-11-02T08:00:00.000Z", total: 10 },
        { id: 2, item: "coffee", placed: "2026-11-02T08:00:00.000Z", total: 10 },
      ],
      rows: 2,
      truncated: false,
      columns: ["id", "item", "placed", "total"],
    });
    expect(await query({ sql: "SELECT count(*) AS n FROM orders;" })).toMatchObject({ items: [{ n: 3 }] });
    expect(await query({ sql: "SELECT item FROM orders ORDER BY id -- newest last", maxRows: 2 })).toMatchObject({ rows: 2, truncated: true });
    expect((await db.client.credential.findFirstOrThrow()).lastUsedAt).not.toBeNull();
  });

  it("M29-S2: nothing that writes, one statement, stopped when slow; the URL's own options can't turn read-only off", async () => {
    await expect(query({ sql: "DELETE FROM orders RETURNING *" })).rejects.toThrow(/^db\.query \(app-db\): syntax error/);
    await expect(query({ sql: "WITH gone AS (DELETE FROM orders RETURNING *) SELECT * FROM gone" })).rejects.toThrow(/^db\.query \(app-db\): /);
    await expect(query({ sql: "SELECT 1) AS x; DROP TABLE orders; SELECT (1" })).rejects.toThrow(/cannot insert multiple commands/);
    await expect(query({ sql: "SELECT nextval('orders_id_seq')" })).rejects.toThrow(/read-only transaction/);
    await expect(query({ sql: "SELECT pg_sleep(5)", timeoutSeconds: 1 })).rejects.toThrow(/statement timeout/);
    expect(await db.client.$queryRawUnsafe<{ n: bigint }[]>("SELECT count(*) AS n FROM m29app.orders")).toEqual([{ n: 3n }]);

    await db.client.credential.deleteMany();
    await store("app-db", appDatabase("-c search_path=m29app -c default_transaction_read_only=off").url, [app.host]);
    expect((await query({ sql: "SELECT current_setting('transaction_read_only') AS ro" })).items).toEqual([{ ro: "on" }]);
  });

  it("M29-S2: only a database credential, only its hosts; the password never in an error", async () => {
    await db.client.credential.deleteMany();
    await store("app-db", app.url, ["db.example.com"]);
    await expect(query({ sql: "SELECT 1 AS one" })).rejects.toThrow(`Credential "app-db" is not allowed on ${app.host}`);

    await db.client.credential.deleteMany();
    await store("app-db", app.url, [app.host], "API_KEY");
    await expect(query({ sql: "SELECT 1 AS one" })).rejects.toThrow(`Credential "app-db" isn't a database connection (kind api key)`);

    await db.client.credential.deleteMany();
    const wrong = new URL(app.url);
    wrong.password = "not-the-password";
    await store("app-db", wrong.href, [app.host]);
    const failed = query({ sql: "SELECT 1 AS one" });
    await expect(failed).rejects.toThrow(/^db\.query \(app-db\): /);
    await expect(failed).rejects.not.toThrow("not-the-password");
    await expect(new DbQueryStep().execute({ connection: "{{cred:app-db}}", sql: "SELECT 1", params: [], maxRows: 1, timeoutSeconds: 1 }, context())).rejects.toThrow(
      "db.query can't use credentials here",
    );
  });

  it("M29-I3: pipelines/table-growth.yaml: told when a table grows 3 times faster than usual, and when it is back", async () => {
    const versionId = await createVersion(db.client, userId, readFileSync(join(__dirname, "../../../pipelines/table-growth.yaml"), "utf8"), new PipelineCompiler(defaultCatalog()));
    const telegram = new Counting("notify.telegram", () => ({ sent: true }));
    const runner = new PipelineRunner(db.client, defaultCatalog(), new ExecutorRegistry([step, new SaveStep(db.client), new HistoryStep(db.client), new AlertStep(db.client), telegram]));
    const hour = async (orders: number, users: number) => {
      await db.client.$executeRawUnsafe(`INSERT INTO m29app.orders (item) SELECT 'x' FROM generate_series(1, ${orders})`);
      await db.client.$executeRawUnsafe(`INSERT INTO m29app.users (id) SELECT nextval('m29app.users_id_seq') FROM generate_series(1, ${users})`);
      expect(await runner.advance(await runner.start(versionId, { trigger: "manual" }))).toBe("DONE");
    };
    // A usual hour: orders +10, users +2.
    for (let i = 0; i < 5; i++) await hour(10, 2);
    expect(telegram.calls).toHaveLength(0);

    await hour(60, 2); // 6 times the usual 10
    expect(telegram.calls.map((c) => c.text)).toEqual(["Tables growing faster than usual (times their usual hourly growth):\norders: 6, above 3"]);
    await hour(80, 2); // still fast: nothing new
    expect(telegram.calls).toHaveLength(1);
    await hour(10, 2); // back
    expect(telegram.calls[1]?.text).toBe("Tables growing faster than usual (times their usual hourly growth):\norders: back to 1");
  });
});

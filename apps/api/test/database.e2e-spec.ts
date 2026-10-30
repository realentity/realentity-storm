import { createPrismaConnection, type PrismaConnection } from "@ai-me/db";

/** Tables owned through their parent; every other table must carry userId (README §9, §17). */
const OWNED_THROUGH_PARENT = ["Decisions", "PipelineVersions", "Steps"];

describe("database schema", () => {
  let db: PrismaConnection;

  beforeAll(() => {
    db = createPrismaConnection();
  });

  afterAll(async () => {
    await db.close();
  });

  // M0-I1
  it("has pgvector available", async () => {
    const rows = await db.client.$queryRaw<{ extname: string }[]>`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
    expect(rows).toHaveLength(1);
    await expect(db.client.$queryRaw`SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector AS distance`).resolves.toBeDefined();
  });

  // M1-I2
  it("has a non-null userId on every user-owned table", async () => {
    const tables = await db.client.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`;
    const userIdColumns = await db.client.$queryRaw<{ table_name: string; is_nullable: string }[]>`
      SELECT table_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'userId'`;

    const withUserId = new Map(userIdColumns.map((c) => [c.table_name, c.is_nullable]));
    const missing = tables.map((t) => t.table_name).filter((name) => !withUserId.has(name) && !OWNED_THROUGH_PARENT.includes(name));
    const nullable = [...withUserId].filter(([, isNullable]) => isNullable === "YES").map(([name]) => name);

    expect(missing).toEqual([]);
    expect(nullable).toEqual([]);
  });

  it("seeds the single user", async () => {
    await expect(db.client.user.count()).resolves.toBe(1);
  });
});

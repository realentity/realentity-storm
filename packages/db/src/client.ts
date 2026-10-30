import { PrismaPg } from "@prisma/adapter-pg";
import { Pool, type PoolConfig } from "pg";
import { PrismaClient } from "./generated/prisma/client";

export interface CreatePrismaOptions {
  /** PostgreSQL connection string; defaults to DATABASE_URL. */
  connectionString?: string;
  /** Extra pg pool settings (max connections, ...). */
  pool?: Omit<PoolConfig, "connectionString">;
}

/** A PrismaClient bound to its own pg Pool, so callers can close both. */
export class PrismaConnection {
  constructor(
    public readonly client: PrismaClient,
    public readonly pool: Pool,
  ) {}

  async close(): Promise<void> {
    await this.client.$disconnect();
    await this.pool.end();
  }
}

export function createPrismaConnection(options: CreatePrismaOptions = {}): PrismaConnection {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  const pool = new Pool({ connectionString, ...options.pool });
  const client = new PrismaClient({ adapter: new PrismaPg(pool) });
  return new PrismaConnection(client, pool);
}

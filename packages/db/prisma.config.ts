import { config } from "dotenv";
import { defineConfig, env } from "prisma/config";
import { resolve } from "node:path";

// One .env in the repository root is shared by api, worker and this package.
config({ path: resolve(__dirname, "../../.env"), quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
    // Unset: prisma migrate dev creates and drops a temporary shadow database (needs CREATEDB).
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL || undefined,
  },
});

import { config } from "dotenv";
import { resolve } from "node:path";
import { createPrismaConnection } from "../src/client";

config({ path: resolve(__dirname, "../../../.env"), quiet: true });

/** The single user (docs/design.md §1). Idempotent: run as often as you like. */
async function seed(): Promise<void> {
  const email = process.env.APP_ADMIN_EMAIL || "me@localhost";
  const connection = createPrismaConnection();
  try {
    const user = await connection.client.user.upsert({ where: { email }, update: {}, create: { email, displayName: "Me" } });
    console.log(`Seeded user ${user.email} (${user.userId})`);
  } finally {
    await connection.close();
  }
}

seed().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

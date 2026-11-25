import { KeyRing } from "@realentity/storm-crypto";
import { createPrismaConnection } from "@realentity/storm-db";
import { config } from "dotenv";
import { resolve } from "node:path";
import { KeyRotation } from "../secrets/key-rotation";

config({ path: resolve(__dirname, "../../../../.env"), quiet: true });

/**
 * pnpm keys:rotate (./docker/storm rotate): re-wraps every secret's data key for ENCRYPTION_KEY_VERSION, and moves any
 * sealed before M64 to that version's public key. Rotation: add ENCRYPTION_KEY_V<n> to .env, set
 * ENCRYPTION_KEY_VERSION=<n>, restart api and worker, run this.
 */
async function main(): Promise<void> {
  const keys = KeyRing.fromEnv(process.env);
  const connection = createPrismaConnection();
  try {
    const result = await new KeyRotation(connection.client, keys).run();
    if (result.rewrapped === 0 && result.skipped === 0) {
      console.log(`Every secret already uses key version ${result.toVersion}, wrapped to its public key.`);
      return;
    }
    console.log(`Re-wrapped ${result.rewrapped} secret(s) from version(s) ${result.fromVersions.join(", ")} to ${result.toVersion}, to its public key.`);
    if (result.skipped > 0) console.log(`${result.skipped} changed during the run; run again to be sure.`);
    console.log("Keep the old key(s) as long as database backups made before this rotation exist.");
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

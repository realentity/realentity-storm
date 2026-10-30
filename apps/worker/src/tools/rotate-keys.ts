import { KeyRing } from "@ai-me/crypto";
import { createPrismaConnection } from "@ai-me/db";
import { config } from "dotenv";
import { resolve } from "node:path";
import { KeyRotation } from "../secrets/key-rotation";

config({ path: resolve(__dirname, "../../../../.env"), quiet: true });

/**
 * pnpm keys:rotate: re-wraps every credential's data key with ENCRYPTION_KEY_VERSION.
 * Rotation: add ENCRYPTION_KEY_V<n> to .env, set ENCRYPTION_KEY_VERSION=<n>, run this, restart api and worker.
 */
async function main(): Promise<void> {
  const keys = KeyRing.fromEnv(process.env);
  const connection = createPrismaConnection();
  try {
    const result = await new KeyRotation(connection.client, keys).run();
    if (result.rewrapped === 0 && result.skipped === 0) {
      console.log(`All credentials already use key version ${result.toVersion}.`);
      return;
    }
    console.log(`Re-wrapped ${result.rewrapped} credential(s) from version(s) ${result.fromVersions.join(", ")} to ${result.toVersion}.`);
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

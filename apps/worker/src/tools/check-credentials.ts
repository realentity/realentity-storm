import { KeyRing } from "@ai-me/crypto";
import { createPrismaConnection } from "@ai-me/db";
import { config } from "dotenv";
import { resolve } from "node:path";
import { checkCredentials } from "../secrets/credential-check";

config({ path: resolve(__dirname, "../../../../.env"), quiet: true });

/**
 * Checks that every stored credential opens with this ENCRYPTION_KEY (restore drill, M5-I1). Prints names and
 * counts only, never a value. Exit code 1 if any credential doesn't open.
 *   pnpm --filter @ai-me/worker check:credentials      on the server: ./docker/aime check
 */
async function main(): Promise<void> {
  const connection = createPrismaConnection();
  try {
    const result = await checkCredentials(connection.client, KeyRing.fromEnv(process.env));
    console.log(`${result.ok.length} credential(s) open with this key${result.ok.length ? `: ${result.ok.join(", ")}` : ""}.`);
    if (result.failed.length > 0) {
      console.log(`${result.failed.length} do NOT open: ${result.failed.map((f) => `${f.name} (key v${f.keyVersion})`).join(", ")}`);
      process.exitCode = 1;
    }
  } finally {
    await connection.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

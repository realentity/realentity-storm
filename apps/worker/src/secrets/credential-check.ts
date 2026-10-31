import { type KeyRing, open } from "@ai-me/crypto";
import { type PrismaClient } from "@ai-me/db";

export interface CredentialCheck {
  ok: string[];
  /** Names (never values) of credentials that don't open: wrong or missing ENCRYPTION_KEY, or tampered rows. */
  failed: { name: string; keyVersion: number }[];
}

/** Opens every credential with the current keys and discards the values (restore drill, after a key change). */
export async function checkCredentials(prisma: PrismaClient, keys: KeyRing): Promise<CredentialCheck> {
  const rows = await prisma.credential.findMany({ orderBy: { name: "asc" } });
  const result: CredentialCheck = { ok: [], failed: [] };
  for (const row of rows) {
    try {
      open(keys, row.credentialId, row);
      result.ok.push(row.name);
    } catch {
      result.failed.push({ name: row.name, keyVersion: row.keyVersion });
    }
  }
  return result;
}

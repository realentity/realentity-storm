import { type KeyRing, open, openField } from "@realentity/storm-crypto";
import { type Prisma, type PrismaClient } from "@realentity/storm-db";
import { isSealed } from "@realentity/storm-shared";

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
  // M50-T7: email accounts' app passwords, by their address.
  for (const row of await prisma.emailAccount.findMany({ orderBy: { address: "asc" } })) {
    try {
      open(keys, row.emailAccountId, row);
      result.ok.push(`email ${row.address}`);
    } catch {
      result.failed.push({ name: `email ${row.address}`, keyVersion: row.keyVersion });
    }
  }
  // M52: App entities' encrypted fields, by where they are (never their values).
  let opened = 0;
  for (const row of await prisma.dataEntity.findMany({ select: { type: true, key: true, value: true, mine: true } })) {
    for (const json of [row.value, row.mine]) {
      for (const [field, value] of Object.entries((json ?? {}) as Prisma.JsonObject)) {
        if (!isSealed(value)) continue;
        try {
          openField(keys, value);
          opened++;
        } catch {
          result.failed.push({ name: `${row.type} ${row.key}: ${field}`, keyVersion: value.$sealed.keyVersion });
        }
      }
    }
  }
  if (opened > 0) result.ok.push(`${opened} encrypted field${opened === 1 ? "" : "s"}`);
  return result;
}

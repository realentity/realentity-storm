import { type KeyRing, rewrap } from "@realentity/storm-crypto";
import { type PrismaClient } from "@realentity/storm-db";

export interface RotationResult {
  rewrapped: number;
  /** Rows changed by someone else during the run (e.g. a replaced secret); they already use the current version or are retried next run. */
  skipped: number;
  fromVersions: number[];
  toVersion: number;
}

/**
 * Moves every sealed secret's data key (credentials, webhook secrets, Google tokens) to the current root key version
 * (docs/design.md §7). Values are never decrypted, only their data keys are re-wrapped. Safe to re-run: each row is updated
 * only if its version is still the old one.
 */
export class KeyRotation {
  private static readonly BATCH = 100;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly keys: KeyRing,
  ) {}

  async run(): Promise<RotationResult> {
    const toVersion = this.keys.currentVersion;
    const fromVersions = new Set<number>();
    let rewrapped = 0;
    let skipped = 0;
    let lastId: string | undefined;

    for (;;) {
      // Keyset paging on the id, not a Prisma cursor: re-wrapped rows leave the filter, so a cursor + skip would skip rows.
      const batch = await this.prisma.credential.findMany({
        where: { keyVersion: { not: toVersion }, ...(lastId ? { credentialId: { gt: lastId } } : {}) },
        select: { credentialId: true, wrappedDek: true, keyVersion: true },
        orderBy: { credentialId: "asc" },
        take: KeyRotation.BATCH,
      });
      if (batch.length === 0) break;

      for (const row of batch) {
        fromVersions.add(row.keyVersion);
        const next = rewrap(this.keys, row.credentialId, row, toVersion);
        const { count } = await this.prisma.credential.updateMany({
          where: { credentialId: row.credentialId, keyVersion: row.keyVersion },
          data: next,
        });
        if (count === 1) rewrapped++;
        else skipped++;
      }
      lastId = batch[batch.length - 1]?.credentialId;
    }

    // Webhook secrets (AAD webhookId) and Google refresh tokens (AAD userId): a few rows each.
    for (const row of await this.prisma.webhook.findMany({ where: { keyVersion: { not: toVersion } } })) {
      fromVersions.add(row.keyVersion);
      const { count } = await this.prisma.webhook.updateMany({
        where: { webhookId: row.webhookId, keyVersion: row.keyVersion },
        data: rewrap(this.keys, row.webhookId, row, toVersion),
      });
      if (count === 1) rewrapped++;
      else skipped++;
    }
    for (const row of await this.prisma.googleConnection.findMany({ where: { keyVersion: { not: toVersion } } })) {
      fromVersions.add(row.keyVersion);
      const { count } = await this.prisma.googleConnection.updateMany({
        where: { userId: row.userId, keyVersion: row.keyVersion },
        data: rewrap(this.keys, row.userId, row, toVersion),
      });
      if (count === 1) rewrapped++;
      else skipped++;
    }

    return { rewrapped, skipped, fromVersions: [...fromVersions].sort((a, b) => a - b), toVersion };
  }
}

import { type KeyRing, rewrap, rewrapField, rewrapIntegration } from "@realentity/storm-crypto";
import { type Prisma, type PrismaClient } from "@realentity/storm-db";
import { isSealed } from "@realentity/storm-shared";

export interface RotationResult {
  rewrapped: number;
  /** Rows changed by someone else during the run (e.g. a replaced secret); they already use the current version or are retried next run. */
  skipped: number;
  fromVersions: number[];
  toVersion: number;
}

/**
 * Moves every sealed secret's data key (credentials, webhook secrets, Google tokens, email account passwords, App entities'
 * encrypted fields, M62's and M63's integrations: the Claude key, the model servers' keys, the bot's token, Google's client secret) to the current root key version
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

    // Webhook secrets (AAD webhookId) and Google refresh tokens (AAD googleAccountId, M50-T8): a few rows each.
    for (const row of await this.prisma.webhook.findMany({ where: { keyVersion: { not: toVersion } } })) {
      fromVersions.add(row.keyVersion);
      const { count } = await this.prisma.webhook.updateMany({
        where: { webhookId: row.webhookId, keyVersion: row.keyVersion },
        data: rewrap(this.keys, row.webhookId, row, toVersion),
      });
      if (count === 1) rewrapped++;
      else skipped++;
    }
    for (const row of await this.prisma.googleAccount.findMany({ where: { keyVersion: { not: toVersion } } })) {
      fromVersions.add(row.keyVersion);
      const { count } = await this.prisma.googleAccount.updateMany({
        where: { googleAccountId: row.googleAccountId, keyVersion: row.keyVersion },
        data: rewrap(this.keys, row.googleAccountId, row, toVersion),
      });
      if (count === 1) rewrapped++;
      else skipped++;
    }

    // M50-T7: email accounts' app passwords (AAD emailAccountId).
    for (const row of await this.prisma.emailAccount.findMany({ where: { keyVersion: { not: toVersion } } })) {
      fromVersions.add(row.keyVersion);
      const { count } = await this.prisma.emailAccount.updateMany({
        where: { emailAccountId: row.emailAccountId, keyVersion: row.keyVersion },
        data: rewrap(this.keys, row.emailAccountId, row, toVersion),
      });
      if (count === 1) rewrapped++;
      else skipped++;
    }

    // M62: the integrations' secrets (their own derived key, AAD "integration:" + the id).
    for (const row of await this.prisma.integration.findMany({ where: { keyVersion: { not: toVersion }, wrappedDek: { not: null } } })) {
      if (!row.wrappedDek || row.keyVersion === null) continue;
      fromVersions.add(row.keyVersion);
      const { count } = await this.prisma.integration.updateMany({
        where: { integrationId: row.integrationId, keyVersion: row.keyVersion },
        data: rewrapIntegration(this.keys, row.integrationId, { wrappedDek: row.wrappedDek, keyVersion: row.keyVersion }, toVersion),
      });
      if (count === 1) rewrapped++;
      else skipped++;
    }

    // M52: App entities' encrypted fields (AAD: where each belongs), in what pipelines wrote and in what I set.
    let lastEntity: string | undefined;
    for (;;) {
      const batch = await this.prisma.dataEntity.findMany({
        where: lastEntity ? { dataEntityId: { gt: lastEntity } } : {},
        select: { dataEntityId: true, value: true, mine: true },
        orderBy: { dataEntityId: "asc" },
        take: KeyRotation.BATCH,
      });
      if (batch.length === 0) break;
      for (const row of batch) {
        const [value, mine] = [this.rewrapFields(row.value, toVersion, fromVersions), this.rewrapFields(row.mine, toVersion, fromVersions)];
        if (value.count + mine.count === 0) continue;
        // Only if nobody changed it meanwhile (a pipeline's save, my edit): else it is retried next run.
        const { count } = await this.prisma.dataEntity.updateMany({
          where: {
            dataEntityId: row.dataEntityId,
            value: { equals: row.value as Prisma.InputJsonValue },
            mine: { equals: row.mine as Prisma.InputJsonValue },
          },
          data: { value: value.json, mine: mine.json },
        });
        if (count === 1) rewrapped += value.count + mine.count;
        else skipped += value.count + mine.count;
      }
      lastEntity = batch[batch.length - 1]?.dataEntityId;
    }

    return { rewrapped, skipped, fromVersions: [...fromVersions].sort((a, b) => a - b), toVersion };
  }

  private rewrapFields(
    json: Prisma.JsonValue,
    toVersion: number,
    fromVersions: Set<number>,
  ): { json: Prisma.InputJsonObject; count: number } {
    const out: Record<string, unknown> = { ...((json ?? {}) as Prisma.JsonObject) };
    let count = 0;
    for (const [field, value] of Object.entries(out)) {
      if (!isSealed(value) || value.$sealed.keyVersion === toVersion) continue;
      fromVersions.add(value.$sealed.keyVersion);
      out[field] = rewrapField(this.keys, value, toVersion);
      count++;
    }
    return { json: out as Prisma.InputJsonObject, count };
  }
}

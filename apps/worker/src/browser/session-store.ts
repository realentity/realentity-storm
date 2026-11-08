import { seal, type KeyRing } from "@realentity/storm-crypto";
import { type PrismaClient } from "@realentity/storm-db";
import { randomUUID } from "node:crypto";
import { type BrowserContextOptions } from "playwright";
import { CredentialNotFoundError, type CredentialVault } from "../secrets/credential-vault";

type StorageState = Exclude<BrowserContextOptions["storageState"], string | undefined>;

/** The credential that keeps a site's login between runs. */
export function sessionName(host: string): string {
  return `session.${host.toLowerCase()}`.slice(0, 64);
}

/**
 * Logins kept between runs (docs/design.md §6): Playwright's storageState (cookies, local storage) as a sealed
 * STORAGE_STATE credential per site, bound to that site's host. It is only ever held in memory and in the database:
 * never written to a file (M8-S4).
 */
export class SessionStore {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly keys: KeyRing,
    private readonly vault: CredentialVault,
  ) {}

  async load(userId: string, host: string): Promise<StorageState | undefined> {
    try {
      const { secret } = await this.vault.revealFor(userId, sessionName(host), host);
      return JSON.parse(secret) as StorageState;
    } catch (error) {
      if (error instanceof CredentialNotFoundError || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  async save(userId: string, host: string, state: StorageState): Promise<void> {
    const name = sessionName(host);
    const secret = JSON.stringify(state);
    const existing = await this.prisma.credential.findUnique({ where: { userId_name: { userId, name } } });
    if (existing && existing.kind !== "STORAGE_STATE") return; // a credential the user named so: leave it alone
    const credentialId = existing?.credentialId ?? randomUUID();
    const sealed = seal(this.keys, credentialId, secret);
    const data = {
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      authTag: sealed.authTag,
      wrappedDek: sealed.wrappedDek,
      keyVersion: sealed.keyVersion,
    };
    if (existing) await this.prisma.credential.update({ where: { credentialId }, data });
    else {
      await this.prisma.credential.create({
        data: { credentialId, userId, name, kind: "STORAGE_STATE", allowedHosts: [host.toLowerCase()], ...data },
      });
    }
  }
}

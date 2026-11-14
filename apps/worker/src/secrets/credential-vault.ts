import { type KeyRing, open } from "@realentity/storm-crypto";
import { type PrismaClient } from "@realentity/storm-db";
import { databaseHost, hostMatches } from "@realentity/storm-shared";

/** M50: a slot no credential is bound to (or one that is gone). */
export class CredentialNotFoundError extends Error {
  constructor(slot: string) {
    super(`"${slot}" has no credential: choose one for it on the pipeline's page (or its App's)`);
  }
}

/** One of Storm's own credentials (a site's session) that isn't there (yet). */
export class OwnCredentialMissingError extends Error {
  constructor(name: string) {
    super(`No credential named "${name}"`);
  }
}

/** Who asks for a credential (a step's context): the user, and the run's slots bound to credentials by id (M50). */
export interface CredentialAsker {
  userId: string;
  credentials?: Readonly<Record<string, string>>;
}

/** Raised when a credential would be filled on a host it isn't bound to (phishing page, injected redirect). */
export class CredentialHostMismatchError extends Error {
  constructor(name: string, host: string) {
    super(`Credential "${name}" is not allowed on ${host}`);
  }
}

export interface RevealedCredential {
  username: string | null;
  secret: string;
}

/**
 * The only place a credential is decrypted (docs/design.md §7), at the moment of use and only for a host in its
 * `allowedHosts`. Callers must not log, persist or send the returned value to the LLM.
 */
export class CredentialVault {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly keys: KeyRing,
  ) {}

  /**
   * One of Storm's own credentials, by the name Storm gave it: a site's browser session (session:<host>), and, until
   * M50-T7 and T9 replace them, the .env mailbox's and a topic's GitHub source. Never a pipeline's: those go through
   * slots (revealFor).
   */
  async revealOwn(userId: string, name: string, host: string): Promise<RevealedCredential> {
    const row = await this.prisma.credential.findUnique({ where: { userId_name: { userId, name } } });
    if (!row) throw new OwnCredentialMissingError(name);
    if (!hostMatches(host, row.allowedHosts)) throw new CredentialHostMismatchError(name, host);
    const secret = open(this.keys, row.credentialId, row);
    await this.prisma.credential.update({ where: { credentialId: row.credentialId }, data: { lastUsedAt: new Date() } });
    return { username: row.username, secret };
  }

  /** The credential bound to the run's `slot` (M50, by id), for `host` only. Never by a credential's name. */
  async revealFor(asker: CredentialAsker, slot: string, host: string): Promise<RevealedCredential> {
    const row = await this.bound(asker, slot);
    if (!hostMatches(host, row.allowedHosts)) throw new CredentialHostMismatchError(row.name, host);

    const secret = open(this.keys, row.credentialId, row);
    await this.prisma.credential.update({ where: { credentialId: row.credentialId }, data: { lastUsedAt: new Date() } });
    return { username: row.username, secret };
  }

  /**
   * A DATABASE credential's connection URL (db.query, M29-T7): the host is inside the value, so it is checked once
   * opened, against the credential's `allowedHosts`, before anything connects.
   */
  async revealConnection(asker: CredentialAsker, slot: string): Promise<RevealedCredential> {
    const row = await this.bound(asker, slot);
    const name = row.name;
    if (row.kind !== "DATABASE") throw new Error(`Credential "${name}" isn't a database connection (kind ${row.kind.toLowerCase().replace("_", " ")})`);
    const secret = open(this.keys, row.credentialId, row);
    const host = databaseHost(secret);
    if (!host) throw new Error(`Credential "${name}" isn't a postgresql:// connection URL`);
    if (!hostMatches(host, row.allowedHosts)) throw new CredentialHostMismatchError(name, host);
    await this.prisma.credential.update({ where: { credentialId: row.credentialId }, data: { lastUsedAt: new Date() } });
    return { username: row.username, secret };
  }

  private async bound(asker: CredentialAsker, slot: string) {
    const credentialId = asker.credentials?.[slot];
    const row = credentialId ? await this.prisma.credential.findFirst({ where: { credentialId, userId: asker.userId } }) : null;
    if (!row) throw new CredentialNotFoundError(slot);
    return row;
  }
}

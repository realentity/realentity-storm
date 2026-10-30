import { type KeyRing, open } from "@ai-me/crypto";
import { type PrismaClient } from "@ai-me/db";
import { hostMatches } from "@ai-me/shared";

export class CredentialNotFoundError extends Error {
  constructor(name: string) {
    super(`No credential named "${name}"`);
  }
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
 * The only place a credential is decrypted (README §7), at the moment of use and only for a host in its
 * `allowedHosts`. Callers must not log, persist or send the returned value to the LLM.
 */
export class CredentialVault {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly keys: KeyRing,
  ) {}

  async revealFor(userId: string, name: string, host: string): Promise<RevealedCredential> {
    const row = await this.prisma.credential.findUnique({ where: { userId_name: { userId, name } } });
    if (!row) throw new CredentialNotFoundError(name);
    if (!hostMatches(host, row.allowedHosts)) throw new CredentialHostMismatchError(name, host);

    const secret = open(this.keys, row.credentialId, row);
    await this.prisma.credential.update({ where: { credentialId: row.credentialId }, data: { lastUsedAt: new Date() } });
    return { username: row.username, secret };
  }
}

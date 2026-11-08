import { KeyRing, seal } from "@realentity/storm-crypto";
import { Prisma } from "@realentity/storm-db";
import { CredentialKind, databaseProblem, type CreateCredentialRequest, type CredentialView } from "@realentity/storm-shared";
import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../database/prisma.service";

/** The only columns the api ever reads: metadata, never the encrypted parts. */
const viewSelect = {
  credentialId: true,
  name: true,
  allowedHosts: true,
  username: true,
  kind: true,
  keyVersion: true,
  lastUsedAt: true,
  dateCreated: true,
  dateUpdated: true,
} satisfies Prisma.CredentialSelect;

type CredentialRow = Prisma.CredentialGetPayload<{ select: typeof viewSelect }>;

/**
 * Credentials are write-only through the api (README §7): it seals values and returns metadata.
 * Decryption exists only in the worker.
 */
@Injectable()
export class CredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: KeyRing,
  ) {}

  async list(userId: string): Promise<CredentialView[]> {
    const rows = await this.prisma.client.credential.findMany({ where: { userId }, select: viewSelect, orderBy: { name: "asc" } });
    return rows.map((row) => CredentialsService.toView(row));
  }

  async create(userId: string, request: CreateCredentialRequest): Promise<CredentialView> {
    // The id is the AAD, so it exists before the value is sealed.
    const credentialId = randomUUID();
    const sealed = seal(this.keys, credentialId, request.secret);
    try {
      const row = await this.prisma.client.credential.create({
        data: {
          credentialId,
          userId,
          name: request.name,
          allowedHosts: request.allowedHosts,
          username: request.username,
          kind: request.kind,
          ...sealed,
        },
        select: viewSelect,
      });
      return CredentialsService.toView(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException(`A credential named "${request.name}" already exists`);
      }
      throw error;
    }
  }

  /** Seals a new value for the same row (new data key, current key version). */
  async replaceSecret(userId: string, credentialId: string, secret: string): Promise<CredentialView> {
    await this.requireOwned(userId, credentialId);
    const { kind, allowedHosts } = await this.prisma.client.credential.findUniqueOrThrow({ where: { credentialId }, select: { kind: true, allowedHosts: true } });
    // A database's new connection string stays on its hosts (M29-T7): another server is another credential.
    const problem = kind === CredentialKind.DATABASE ? databaseProblem(secret, allowedHosts) : null;
    if (problem) throw new BadRequestException({ message: "Validation failed", errors: [{ path: "", message: problem }] });
    const row = await this.prisma.client.credential.update({
      where: { credentialId },
      data: { ...seal(this.keys, credentialId, secret) },
      select: viewSelect,
    });
    return CredentialsService.toView(row);
  }

  async remove(userId: string, credentialId: string): Promise<void> {
    const { count } = await this.prisma.client.credential.deleteMany({ where: { credentialId, userId } });
    if (count === 0) throw new NotFoundException();
  }

  private async requireOwned(userId: string, credentialId: string): Promise<void> {
    const found = await this.prisma.client.credential.count({ where: { credentialId, userId } });
    if (found === 0) throw new NotFoundException();
  }

  private static toView(row: CredentialRow): CredentialView {
    return {
      credentialId: row.credentialId,
      name: row.name,
      allowedHosts: row.allowedHosts,
      username: row.username,
      kind: row.kind,
      keyVersion: row.keyVersion,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      dateCreated: row.dateCreated.toISOString(),
      dateUpdated: row.dateUpdated.toISOString(),
    };
  }
}

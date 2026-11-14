import { KeyRing, seal } from "@realentity/storm-crypto";
import { Prisma } from "@realentity/storm-db";
import type { EmailAccountRequestSchema, EmailAccountUpdate, EmailAccountView } from "@realentity/storm-shared";
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { PrismaService } from "../database/prisma.service";

/** The only columns the api reads: never the sealed password. */
const viewSelect = {
  emailAccountId: true,
  address: true,
  label: true,
  imapHost: true,
  imapPort: true,
  smtpHost: true,
  smtpPort: true,
  tls: true,
  isDefault: true,
  lastUsedAt: true,
} satisfies Prisma.EmailAccountSelect;

type AccountRow = Prisma.EmailAccountGetPayload<{ select: typeof viewSelect }>;

/**
 * M50-T7: the user's mailboxes. Like credentials (docs/design.md §7) the password is sealed here (AAD: the account's
 * id) and opened only in the worker. One of them is the default: the first added, or the one chosen since.
 */
@Injectable()
export class EmailAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: KeyRing,
  ) {}

  async list(userId: string): Promise<EmailAccountView[]> {
    const rows = await this.prisma.client.emailAccount.findMany({
      where: { userId },
      select: viewSelect,
      orderBy: [{ isDefault: "desc" }, { address: "asc" }],
    });
    const bindings = await this.prisma.client.binding.findMany({
      where: { emailAccountId: { in: rows.map((r) => r.emailAccountId) } },
      include: { pipeline: { select: { name: true } }, app: { select: { name: true } } },
      orderBy: { slot: "asc" },
    });
    return rows.map((row) =>
      EmailAccountsService.toView(
        row,
        bindings
          .filter((b) => b.emailAccountId === row.emailAccountId)
          .map((b) =>
            b.pipelineId
              ? { owner: "pipeline" as const, id: b.pipelineId, name: b.pipeline?.name ?? "", slot: b.slot }
              : { owner: "app" as const, id: b.appId ?? "", name: b.app?.name ?? "", slot: b.slot },
          ),
      ),
    );
  }

  async create(userId: string, request: z.output<typeof EmailAccountRequestSchema>): Promise<EmailAccountView> {
    const emailAccountId = randomUUID();
    const { password, isDefault, ...fields } = request;
    try {
      const row = await this.prisma.client.$transaction(async (tx) => {
        const first = (await tx.emailAccount.count({ where: { userId } })) === 0;
        const makeDefault = first || isDefault === true;
        if (makeDefault) await tx.emailAccount.updateMany({ where: { userId }, data: { isDefault: false } });
        return tx.emailAccount.create({
          data: {
            emailAccountId,
            userId,
            ...fields,
            label: fields.label || null,
            isDefault: makeDefault,
            ...seal(this.keys, emailAccountId, password),
          },
          select: viewSelect,
        });
      });
      return EmailAccountsService.toView(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException(`${request.address} is already one of your email accounts`);
      }
      throw error;
    }
  }

  async update(userId: string, emailAccountId: string, update: EmailAccountUpdate): Promise<EmailAccountView> {
    await this.requireOwned(userId, emailAccountId);
    const row = await this.prisma.client.$transaction(async (tx) => {
      if (update.isDefault) await tx.emailAccount.updateMany({ where: { userId }, data: { isDefault: false } });
      return tx.emailAccount.update({
        where: { emailAccountId },
        data: {
          ...(update.label !== undefined && { label: update.label || null }),
          ...(update.isDefault && { isDefault: true }),
          ...(update.password && seal(this.keys, emailAccountId, update.password)),
        },
        select: viewSelect,
      });
    });
    return EmailAccountsService.toView(row);
  }

  /** Removing the default makes the oldest left the default. Slots filled with it fall back to the default. */
  async remove(userId: string, emailAccountId: string): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      // M50-T16: the topics that read it read the default account again (an attachment keeps what was indexed).
      await tx.topicSource.deleteMany({ where: { userId, kind: "MAILBOX", emailAccountId } });
      const { count } = await tx.emailAccount.deleteMany({ where: { emailAccountId, userId } });
      if (count === 0) throw new NotFoundException();
      if ((await tx.emailAccount.count({ where: { userId, isDefault: true } })) > 0) return;
      const next = await tx.emailAccount.findFirst({
        where: { userId },
        orderBy: { dateCreated: "asc" },
        select: { emailAccountId: true },
      });
      if (next) await tx.emailAccount.update({ where: { emailAccountId: next.emailAccountId }, data: { isDefault: true } });
    });
  }

  private async requireOwned(userId: string, emailAccountId: string): Promise<void> {
    const found = await this.prisma.client.emailAccount.count({ where: { emailAccountId, userId } });
    if (found === 0) throw new NotFoundException();
  }

  private static toView(row: AccountRow, usedBy: EmailAccountView["usedBy"] = []): EmailAccountView {
    return { ...row, lastUsedAt: row.lastUsedAt?.toISOString() ?? null, usedBy };
  }
}

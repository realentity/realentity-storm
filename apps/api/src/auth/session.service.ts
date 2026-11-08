import { type ServerEnv } from "@realentity/storm-shared";
import { Inject, Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { SERVER_ENV } from "../config/server-env";
import { PrismaService } from "../database/prisma.service";
import { type AuthenticatedUser } from "./public.decorator";

/** Refresh lastSeenAt at most this often, so every request doesn't write. */
const LAST_SEEN_RESOLUTION_MS = 5 * 60 * 1000;

/** Server-side sessions: the cookie carries a random token, the database only its SHA-256. */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  async create(userId: string, meta: { ipAddress?: string; userAgent?: string }): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.env.SESSION_TTL_HOURS * 60 * 60 * 1000);
    await this.prisma.client.userSession.create({
      data: {
        userId,
        tokenHash: SessionService.hash(token),
        expiresAt,
        ipAddress: meta.ipAddress?.slice(0, 64),
        userAgent: meta.userAgent?.slice(0, 500),
      },
    });
    return { token, expiresAt };
  }

  async resolve(token: string): Promise<AuthenticatedUser | null> {
    const session = await this.prisma.client.userSession.findUnique({
      where: { tokenHash: SessionService.hash(token) },
      include: { user: { select: { email: true } } },
    });
    if (!session) return null;
    const now = Date.now();
    if (session.expiresAt.getTime() <= now) {
      await this.prisma.client.userSession.deleteMany({ where: { userSessionId: session.userSessionId } });
      return null;
    }
    if (!session.lastSeenAt || now - session.lastSeenAt.getTime() > LAST_SEEN_RESOLUTION_MS) {
      await this.prisma.client.userSession.update({ where: { userSessionId: session.userSessionId }, data: { lastSeenAt: new Date(now) } });
    }
    return { userId: session.userId, email: session.user.email, userSessionId: session.userSessionId, expiresAt: session.expiresAt };
  }

  async revoke(userSessionId: string): Promise<void> {
    await this.prisma.client.userSession.deleteMany({ where: { userSessionId } });
  }

  static hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
}

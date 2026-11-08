import { type LoginRequest, type ServerEnv } from "@realentity/storm-shared";
import { Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { verify } from "argon2";
import { authenticator } from "otplib";
import { SERVER_ENV } from "../config/server-env";
import { PrismaService } from "../database/prisma.service";

/**
 * Single-user login: password (argon2id hash) + TOTP, both from .env (docs/design.md §14).
 * Brute force is limited by the throttler on the login route.
 */
@Injectable()
export class AuthService {
  /** The last accepted TOTP code, so a code can't be replayed within its validity window. */
  private lastAcceptedTotp: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {
    authenticator.options = { window: 1 };
  }

  /** Returns the user id on success. Wrong password and wrong code fail the same way. */
  async verify(request: LoginRequest): Promise<{ userId: string; email: string }> {
    const { APP_ADMIN_PASSWORD_HASH: hash, APP_TOTP_SECRET: totpSecret, APP_ADMIN_EMAIL: email } = this.env;
    if (!hash || !totpSecret) {
      throw new ServiceUnavailableException("Login is not configured: run pnpm auth:setup and set the values in .env");
    }

    const passwordOk = await verify(hash, request.password);
    const totpOk = authenticator.check(request.totp, totpSecret) && request.totp !== this.lastAcceptedTotp;
    if (!passwordOk || !totpOk) {
      throw new UnauthorizedException("Invalid credentials");
    }
    this.lastAcceptedTotp = request.totp;

    const user = await this.prisma.client.user.findUnique({ where: { email }, select: { userId: true, email: true } });
    if (!user) {
      throw new ServiceUnavailableException("The user is not seeded: run pnpm db:seed");
    }
    return user;
  }
}

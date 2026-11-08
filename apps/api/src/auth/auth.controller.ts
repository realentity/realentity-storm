import { LoginSchema, SESSION_COOKIE, type LoginRequest, type ServerEnv, type SessionView } from "@realentity/storm-shared";
import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { type CookieOptions, type Request, type Response } from "express";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { SERVER_ENV } from "../config/server-env";
import { AuthService } from "./auth.service";
import { CurrentUser, Public, type AuthenticatedUser } from "./public.decorator";
import { SessionService } from "./session.service";

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  /** 5 attempts per minute per client (M1-S5). */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("login")
  @HttpCode(200)
  async login(
    @Body(new ZodBodyPipe(LoginSchema)) body: LoginRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionView> {
    const user = await this.auth.verify(body);
    const session = await this.sessions.create(user.userId, { ipAddress: request.ip, userAgent: request.get("user-agent") });
    response.cookie(SESSION_COOKIE, session.token, { ...this.cookieOptions(), expires: session.expiresAt });
    return { userId: user.userId, email: user.email, expiresAt: session.expiresAt.toISOString() };
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) response: Response): Promise<void> {
    await this.sessions.revoke(user.userSessionId);
    response.clearCookie(SESSION_COOKIE, this.cookieOptions());
  }

  @Get("session")
  session(@CurrentUser() user: AuthenticatedUser): SessionView {
    return { userId: user.userId, email: user.email, expiresAt: user.expiresAt.toISOString() };
  }

  private cookieOptions(): CookieOptions {
    return { httpOnly: true, sameSite: "strict", secure: this.env.NODE_ENV === "production", path: "/" };
  }
}

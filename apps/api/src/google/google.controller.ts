import { GoogleClientSchema, type GoogleClientRequest, type GoogleClientView, type GoogleStatusView } from "@realentity/storm-shared";
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { type Request, type Response } from "express";
import { z } from "zod";
import { CurrentUser, Public, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { GoogleClientService } from "./google-client.service";
import { GoogleService } from "./google.service";

/** `account`: reconnecting that one; left out, choosing an account at Google (another one is added). */
const ConnectSchema = z.object({ returnTo: z.string().max(500).optional(), account: z.uuid().optional() }).strict();

/** Google Calendar (M14-T1): its state, connecting (the consent screen), Google's way back, and disconnecting. */
@Controller("google")
export class GoogleController {
  constructor(
    private readonly google: GoogleService,
    private readonly clients: GoogleClientService,
  ) {}

  @Get()
  status(@CurrentUser() user: AuthenticatedUser, @Req() request: Request): Promise<GoogleStatusView> {
    return this.google.status(user.userId, originOf(request));
  }

  /** M63: Google's OAuth client (Settings → Google): its id, and only a hint of its secret. */
  @Get("client")
  client(@CurrentUser() user: AuthenticatedUser): Promise<GoogleClientView> {
    return this.clients.get(user.userId);
  }

  @Put("client")
  saveClient(@CurrentUser() user: AuthenticatedUser, @Body(new ZodBodyPipe(GoogleClientSchema)) body: GoogleClientRequest): Promise<GoogleClientView> {
    return this.clients.save(user.userId, body);
  }

  @Delete("client")
  @HttpCode(204)
  removeClient(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.clients.remove(user.userId);
  }

  @Post("connect")
  connect(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
    @Body(new ZodBodyPipe(ConnectSchema)) body: z.infer<typeof ConnectSchema>,
  ): Promise<{ url: string }> {
    return this.google.connect(user.userId, originOf(request), body.returnTo, body.account);
  }

  /**
   * Google sends the browser here after the consent screen. Public: coming from accounts.google.com, the browser
   * doesn't send the SameSite=Strict session cookie; the sign-in's one-time state says whose it is.
   */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get("callback")
  async callback(
    @Req() request: Request,
    @Res() response: Response,
    @Query() query: { code?: string; state?: string; error?: string },
  ): Promise<void> {
    response.redirect(302, await this.google.callback(originOf(request), query));
  }

  @Put("accounts/:googleAccountId/default")
  @HttpCode(204)
  makeDefault(@CurrentUser() user: AuthenticatedUser, @Param("googleAccountId", ParseUUIDPipe) googleAccountId: string): Promise<void> {
    return this.google.makeDefault(user.userId, googleAccountId);
  }

  @Delete("accounts/:googleAccountId")
  @HttpCode(204)
  disconnect(@CurrentUser() user: AuthenticatedUser, @Param("googleAccountId", ParseUUIDPipe) googleAccountId: string): Promise<void> {
    return this.google.disconnect(user.userId, googleAccountId);
  }
}

/** Where the browser reached the api, for the redirect URI when APP_ORIGIN isn't set (development). */
function originOf(request: Request): string {
  return `${request.protocol}://${request.get("host") ?? "localhost"}`;
}

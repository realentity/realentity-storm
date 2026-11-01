import { type GoogleStatusView } from "@ai-me/shared";
import { Body, Controller, Delete, Get, HttpCode, Post, Query, Req, Res } from "@nestjs/common";
import { type Request, type Response } from "express";
import { z } from "zod";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { GoogleService } from "./google.service";

const ConnectSchema = z.object({ returnTo: z.string().max(500).optional() }).strict();

/** Google Calendar (M14-T1): its state, connecting (the consent screen), Google's way back, and disconnecting. */
@Controller("google")
export class GoogleController {
  constructor(private readonly google: GoogleService) {}

  @Get()
  status(@CurrentUser() user: AuthenticatedUser, @Req() request: Request): Promise<GoogleStatusView> {
    return this.google.status(user.userId, originOf(request));
  }

  @Post("connect")
  connect(@CurrentUser() user: AuthenticatedUser, @Req() request: Request, @Body(new ZodBodyPipe(ConnectSchema)) body: z.infer<typeof ConnectSchema>): Promise<{ url: string }> {
    return this.google.connect(user.userId, originOf(request), body.returnTo);
  }

  /** Google sends the browser here after the consent screen (my session cookie comes along: a top-level GET). */
  @Get("callback")
  async callback(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: Request,
    @Res() response: Response,
    @Query() query: { code?: string; state?: string; error?: string },
  ): Promise<void> {
    response.redirect(302, await this.google.callback(user.userId, originOf(request), query));
  }

  @Delete()
  @HttpCode(204)
  disconnect(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.google.disconnect(user.userId);
  }
}

/** Where the browser reached the api, for the redirect URI when APP_ORIGIN isn't set (development). */
function originOf(request: Request): string {
  return `${request.protocol}://${request.get("host") ?? "localhost"}`;
}

import { AppUsesRequestSchema, type AppUsesRequest, type AppUseView } from "@realentity/storm-shared";
import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { AppUsesService } from "./app-uses.service";

/** M66: which of the user's Apps fills each use of another App's type. */
@Controller("apps/:appId/uses")
export class AppUsesController {
  constructor(private readonly uses: AppUsesService) {}

  @Get()
  of(@CurrentUser() user: AuthenticatedUser, @Param("appId", ParseUUIDPipe) appId: string): Promise<AppUseView[]> {
    return this.uses.of(user.userId, appId);
  }

  /** `{ Bill: { appId, type } }`; null clears one. */
  @Put()
  set(
    @CurrentUser() user: AuthenticatedUser,
    @Param("appId", ParseUUIDPipe) appId: string,
    @Body(new ZodBodyPipe(AppUsesRequestSchema)) body: AppUsesRequest,
  ): Promise<AppUseView[]> {
    return this.uses.set(user.userId, appId, body);
  }
}

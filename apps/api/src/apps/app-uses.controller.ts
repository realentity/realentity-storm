import { AppUsesRequestSchema, type AppUseChoiceView, type AppUsesRequest, type AppUseView } from "@realentity/storm-shared";
import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { AppPagesService } from "./app-pages.service";
import { AppUsesService } from "./app-uses.service";

/** M66: which of the user's Apps fills each use of another App's type. */
@Controller("apps/:appId/uses")
export class AppUsesController {
  constructor(
    private readonly uses: AppUsesService,
    private readonly pages: AppPagesService,
  ) {}

  @Get()
  of(@CurrentUser() user: AuthenticatedUser, @Param("appId", ParseUUIDPipe) appId: string): Promise<AppUseView[]> {
    return this.uses.of(user.userId, appId);
  }

  /** A ref's choices through a use: the chosen App's entities by key and title; none until chosen. */
  @Get(":name/choices")
  choices(
    @CurrentUser() user: AuthenticatedUser,
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("name") name: string,
  ): Promise<AppUseChoiceView[]> {
    return this.pages.useChoices(user.userId, appId, name);
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

import {
  AppListQuerySchema,
  AppPreviewRequestSchema,
  EntityValuesRequestSchema,
  MoveStageRequestSchema,
  PageActionRequestSchema,
  type AppEntityView,
  type AppListQueryParsed,
  type AppListView,
  type AppMenuItem,
  type AppPreviewRequest,
  type AppPreviewView,
  type EntityValuesRequest,
  type MoveStageRequest,
  type PageActionRequest,
  type RunDetailView,
} from "@realentity/storm-shared";
import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Query } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { AppPagesService } from "./app-pages.service";
import { EntityActionsService } from "./entity-actions.service";

/** An App's pages (M31): the menu, a type's list, an entity's page. Registered before AppsController: /apps/menu. */
@Controller("apps")
export class AppPagesController {
  constructor(
    private readonly pages: AppPagesService,
    private readonly actions: EntityActionsService,
  ) {}

  @Get("menu")
  menu(@CurrentUser() user: AuthenticatedUser): Promise<AppMenuItem[]> {
    return this.pages.menu(user.userId);
  }

  /** M37-T2: a page of a draft App, with the App's entities or a sample; nothing is saved. */
  @Post("preview")
  @HttpCode(200)
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(AppPreviewRequestSchema)) body: AppPreviewRequest,
  ): Promise<AppPreviewView> {
    return this.pages.preview(user.userId, body);
  }

  @Get(":appId/pages/:type")
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("type") type: string,
    @Query(new ZodBodyPipe(AppListQuerySchema)) query: AppListQueryParsed,
  ): Promise<AppListView> {
    return this.pages.list(user.userId, appId, type, query);
  }

  @Get(":appId/pages/:type/:key")
  entity(
    @CurrentUser() user: AuthenticatedUser,
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("type") type: string,
    @Param("key") key: string,
  ): Promise<AppEntityView> {
    return this.pages.entity(user.userId, appId, type, key);
  }

  /** M32: an entity of a type the user writes (mine), from its list's form. */
  @Post(":appId/pages/:type")
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("type") type: string,
    @Body(new ZodBodyPipe(EntityValuesRequestSchema)) body: EntityValuesRequest,
  ): Promise<AppEntityView> {
    const key = await this.actions.create(user.userId, appId, type, body.values);
    return this.pages.entity(user.userId, appId, type, key);
  }

  /** M32: the user's fields on its form. */
  @Put(":appId/pages/:type/:key/values")
  async saveValues(
    @CurrentUser() user: AuthenticatedUser,
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("type") type: string,
    @Param("key") key: string,
    @Body(new ZodBodyPipe(EntityValuesRequestSchema)) body: EntityValuesRequest,
  ): Promise<AppEntityView> {
    await this.actions.saveValues(user.userId, appId, type, key, body.values);
    return this.pages.entity(user.userId, appId, type, key);
  }

  /** M32: its stage, moved. */
  @Put(":appId/pages/:type/:key/stage")
  async move(
    @CurrentUser() user: AuthenticatedUser,
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("type") type: string,
    @Param("key") key: string,
    @Body(new ZodBodyPipe(MoveStageRequestSchema)) body: MoveStageRequest,
  ): Promise<AppEntityView> {
    await this.actions.move(user.userId, appId, type, key, body.to);
    return this.pages.entity(user.userId, appId, type, key);
  }

  @Delete(":appId/pages/:type/:key")
  @HttpCode(204)
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("type") type: string,
    @Param("key") key: string,
  ): Promise<void> {
    return this.actions.remove(user.userId, appId, type, key);
  }

  /** M32: a list's button (no key) or an entity's; queues a run, like starting it by hand. */
  @Post(":appId/actions/:type/:index")
  @HttpCode(202)
  act(
    @CurrentUser() user: AuthenticatedUser,
    @Param("appId", ParseUUIDPipe) appId: string,
    @Param("type") type: string,
    @Param("index", ParseIntPipe) index: number,
    @Body(new ZodBodyPipe(PageActionRequestSchema)) body: PageActionRequest,
  ): Promise<RunDetailView> {
    return this.actions.act(user.userId, appId, type, index, body.key);
  }
}

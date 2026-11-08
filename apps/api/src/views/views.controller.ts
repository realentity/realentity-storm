import {
  ViewActionRequestSchema,
  ViewMarkRequestSchema,
  ViewQuerySchema,
  type RunDetailView,
  type ViewActionRequest,
  type ViewMarkRequest,
  type ViewMenuItem,
  type ViewPageView,
  type ViewQuery,
  type ViewRow,
  type ViewRowView,
} from "@realentity/storm-shared";
import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Query } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { ViewsService } from "./views.service";

/** Pipelines' pages (M27): the menu, a page's rows, one row, the user's marks, the buttons. */
@Controller("views")
export class ViewsController {
  constructor(private readonly views: ViewsService) {}

  @Get()
  menu(@CurrentUser() user: AuthenticatedUser): Promise<ViewMenuItem[]> {
    return this.views.menu(user.userId);
  }

  @Get(":pipelineId")
  page(
    @CurrentUser() user: AuthenticatedUser,
    @Param("pipelineId", ParseUUIDPipe) pipelineId: string,
    @Query(new ZodBodyPipe(ViewQuerySchema)) query: ViewQuery,
  ): Promise<ViewPageView> {
    return this.views.page(user.userId, pipelineId, query);
  }

  @Get(":pipelineId/rows/:key")
  row(
    @CurrentUser() user: AuthenticatedUser,
    @Param("pipelineId", ParseUUIDPipe) pipelineId: string,
    @Param("key") key: string,
  ): Promise<ViewRowView> {
    return this.views.row(user.userId, pipelineId, key);
  }

  @Put(":pipelineId/rows/:key/marks/:markId")
  mark(
    @CurrentUser() user: AuthenticatedUser,
    @Param("pipelineId", ParseUUIDPipe) pipelineId: string,
    @Param("key") key: string,
    @Param("markId") markId: string,
    @Body(new ZodBodyPipe(ViewMarkRequestSchema)) body: ViewMarkRequest,
  ): Promise<ViewRow> {
    return this.views.mark(user.userId, pipelineId, key, markId, body.on);
  }

  /** Queues a run, like starting it by hand; a row's button passes the row. */
  @Post(":pipelineId/actions/:index")
  @HttpCode(202)
  act(
    @CurrentUser() user: AuthenticatedUser,
    @Param("pipelineId", ParseUUIDPipe) pipelineId: string,
    @Param("index", ParseIntPipe) index: number,
    @Body(new ZodBodyPipe(ViewActionRequestSchema)) body: ViewActionRequest,
  ): Promise<RunDetailView> {
    return this.views.act(user.userId, pipelineId, index, body.key);
  }
}

import { WatchedProductSchema, type PipelineDetailView, type PriceHistoryView, type PricesStatusView, type WatchedProductView } from "@ai-me/shared";
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import { type z } from "zod";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { PricesService } from "./prices.service";

type Body = z.infer<typeof WatchedProductSchema>;

/** The Prices page (M24). */
@Controller("prices")
export class PricesController {
  constructor(private readonly prices: PricesService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<WatchedProductView[]> {
    return this.prices.list(user.userId);
  }

  @Get("status")
  status(@CurrentUser() user: AuthenticatedUser): Promise<PricesStatusView> {
    return this.prices.status(user.userId);
  }

  @Post("pipeline")
  createPipeline(@CurrentUser() user: AuthenticatedUser): Promise<PipelineDetailView> {
    return this.prices.createPipeline(user.userId);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body(new ZodBodyPipe(WatchedProductSchema)) body: Body): Promise<WatchedProductView> {
    return this.prices.create(user.userId, body);
  }

  @Put(":id")
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodBodyPipe(WatchedProductSchema)) body: Body,
  ): Promise<WatchedProductView> {
    return this.prices.update(user.userId, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    return this.prices.remove(user.userId, id);
  }

  @Get(":id/history")
  history(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string): Promise<PriceHistoryView> {
    return this.prices.history(user.userId, id);
  }
}

import { StartRunSchema, type RunDetailView, type RunSummaryView, type StartRunRequest } from "@ai-me/shared";
import { Body, Controller, DefaultValuePipe, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { RunsService } from "./runs.service";

@Controller()
export class RunsController {
  constructor(private readonly runs: RunsService) {}

  /** Queues a run of the current version; the worker executes it. */
  @Post("pipelines/:pipelineId/runs")
  @HttpCode(202)
  start(
    @CurrentUser() user: AuthenticatedUser,
    @Param("pipelineId", ParseUUIDPipe) pipelineId: string,
    @Body(new ZodBodyPipe(StartRunSchema)) body: StartRunRequest,
  ): Promise<RunDetailView> {
    return this.runs.start(user.userId, pipelineId, body.dryRun);
  }

  @Get("runs")
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("pipelineId", new ParseUUIDPipe({ optional: true })) pipelineId?: string,
    @Query("limit", new DefaultValuePipe(50), ParseIntPipe) limit = 50,
  ): Promise<RunSummaryView[]> {
    return this.runs.list(user.userId, pipelineId, Math.min(Math.max(limit, 1), 200));
  }

  @Get("runs/:runId")
  get(@CurrentUser() user: AuthenticatedUser, @Param("runId", ParseUUIDPipe) runId: string): Promise<RunDetailView> {
    return this.runs.get(user.userId, runId);
  }
}

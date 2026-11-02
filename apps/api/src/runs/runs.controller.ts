import {
  RunFilterSchema,
  StartRunSchema,
  type RunDetailView,
  type RunFilter,
  type RunSummaryView,
  type StartRunRequest,
} from "@ai-me/shared";
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
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

  /** History, newest first; page with `before` (the last row's startedAt). */
  @Get("runs")
  list(@CurrentUser() user: AuthenticatedUser, @Query(new ZodBodyPipe(RunFilterSchema)) filter: RunFilter): Promise<RunSummaryView[]> {
    return this.runs.list(user.userId, filter);
  }

  /** M17-T1: a failed run goes on from its failed steps (not a failed side effect). */
  @Post("runs/:runId/retry")
  @HttpCode(202)
  retry(@CurrentUser() user: AuthenticatedUser, @Param("runId", ParseUUIDPipe) runId: string): Promise<RunDetailView> {
    return this.runs.retry(user.userId, runId);
  }

  @Get("runs/:runId")
  get(@CurrentUser() user: AuthenticatedUser, @Param("runId", ParseUUIDPipe) runId: string): Promise<RunDetailView> {
    return this.runs.get(user.userId, runId);
  }
}

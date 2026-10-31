import {
  CompilePipelineSchema,
  DryRunPipelineSchema,
  PipelineSourceSchema,
  UpdatePipelineSchema,
  type CompilePipelineRequest,
  type CompilePipelineResponse,
  type DryRunPipelineRequest,
  type DryRunPipelineResponse,
  type PipelineDetailView,
  type PipelineSourceRequest,
  type PipelineSummaryView,
  type PipelineVersionView,
  type UpdatePipelineRequest,
} from "@ai-me/shared";
import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { PipelinesService } from "./pipelines.service";

@Controller("pipelines")
export class PipelinesController {
  constructor(private readonly pipelines: PipelinesService) {}

  /** Compile only (review screen): errors, or the compiled plan + policy, and the diff when pipelineId is given. */
  @Post("compile")
  @HttpCode(200)
  compile(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(CompilePipelineSchema)) body: CompilePipelineRequest,
  ): Promise<CompilePipelineResponse> {
    return this.pipelines.compile(user.userId, body.source, body.pipelineId);
  }

  /** Dry run before saving: the source becomes the draft (of a new pipeline without pipelineId) and a dry run starts. */
  @Post("dry-run")
  @HttpCode(202)
  dryRun(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(DryRunPipelineSchema)) body: DryRunPipelineRequest,
  ): Promise<DryRunPipelineResponse> {
    return this.pipelines.dryRun(user.userId, body.source, body.pipelineId);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<PipelineSummaryView[]> {
    return this.pipelines.list(user.userId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(PipelineSourceSchema)) body: PipelineSourceRequest,
  ): Promise<PipelineDetailView> {
    return this.pipelines.create(user.userId, body.source);
  }

  @Get(":pipelineId")
  get(@CurrentUser() user: AuthenticatedUser, @Param("pipelineId", ParseUUIDPipe) pipelineId: string): Promise<PipelineDetailView> {
    return this.pipelines.get(user.userId, pipelineId);
  }

  @Patch(":pipelineId")
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("pipelineId", ParseUUIDPipe) pipelineId: string,
    @Body(new ZodBodyPipe(UpdatePipelineSchema)) body: UpdatePipelineRequest,
  ): Promise<PipelineDetailView> {
    return this.pipelines.update(user.userId, pipelineId, body);
  }

  /** Discards the draft and its dry runs (and the pipeline, if it was never saved). */
  @Delete(":pipelineId/draft")
  @HttpCode(204)
  discardDraft(@CurrentUser() user: AuthenticatedUser, @Param("pipelineId", ParseUUIDPipe) pipelineId: string): Promise<void> {
    return this.pipelines.discardDraft(user.userId, pipelineId);
  }

  @Post(":pipelineId/versions")
  addVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param("pipelineId", ParseUUIDPipe) pipelineId: string,
    @Body(new ZodBodyPipe(PipelineSourceSchema)) body: PipelineSourceRequest,
  ): Promise<PipelineDetailView> {
    return this.pipelines.addVersion(user.userId, pipelineId, body.source);
  }

  @Get(":pipelineId/versions/:version")
  getVersion(
    @CurrentUser() user: AuthenticatedUser,
    @Param("pipelineId", ParseUUIDPipe) pipelineId: string,
    @Param("version", ParseIntPipe) version: number,
  ): Promise<PipelineVersionView> {
    return this.pipelines.getVersion(user.userId, pipelineId, version);
  }
}

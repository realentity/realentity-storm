import {
  CompilePipelineSchema,
  PipelineSourceSchema,
  UpdatePipelineSchema,
  type CompilePipelineRequest,
  type CompilePipelineResponse,
  type PipelineDetailView,
  type PipelineSourceRequest,
  type PipelineSummaryView,
  type PipelineVersionView,
  type UpdatePipelineRequest,
} from "@ai-me/shared";
import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
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

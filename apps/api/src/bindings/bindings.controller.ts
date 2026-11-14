import { BindingsRequestSchema, type BindingsRequest, type BindingView } from "@realentity/storm-shared";
import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { BindingsService } from "./bindings.service";

/** M50: what fills a pipeline's or an App install's slots. */
@Controller()
export class BindingsController {
  constructor(private readonly bindings: BindingsService) {}

  @Get("pipelines/:pipelineId/bindings")
  ofPipeline(@CurrentUser() user: AuthenticatedUser, @Param("pipelineId", ParseUUIDPipe) pipelineId: string): Promise<BindingView[]> {
    return this.bindings.ofPipeline(user.userId, pipelineId);
  }

  /** `{ slot: { credentialId } | { text } }`; null clears one. Only the pipeline's own slots: its App's are the App's. */
  @Put("pipelines/:pipelineId/bindings")
  setPipeline(
    @CurrentUser() user: AuthenticatedUser,
    @Param("pipelineId", ParseUUIDPipe) pipelineId: string,
    @Body(new ZodBodyPipe(BindingsRequestSchema)) body: BindingsRequest,
  ): Promise<BindingView[]> {
    return this.bindings.setPipeline(user.userId, pipelineId, body);
  }

  @Get("apps/:appId/bindings")
  ofApp(@CurrentUser() user: AuthenticatedUser, @Param("appId", ParseUUIDPipe) appId: string): Promise<BindingView[]> {
    return this.bindings.ofApp(user.userId, appId);
  }

  @Put("apps/:appId/bindings")
  setApp(
    @CurrentUser() user: AuthenticatedUser,
    @Param("appId", ParseUUIDPipe) appId: string,
    @Body(new ZodBodyPipe(BindingsRequestSchema)) body: BindingsRequest,
  ): Promise<BindingView[]> {
    return this.bindings.setApp(user.userId, appId, body);
  }
}

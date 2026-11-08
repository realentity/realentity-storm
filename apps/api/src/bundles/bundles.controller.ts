import { BundleRequestSchema, type BundleCheckView, type BundleExportView, type BundleRequest } from "@realentity/storm-shared";
import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { BundlesService } from "./bundles.service";

/** M35-T5: Apps and pipelines in and out as YAML files. */
@Controller("bundles")
export class BundlesController {
  constructor(private readonly bundles: BundlesService) {}

  /** What importing the file would do, nothing saved. */
  @Post("check")
  check(@CurrentUser() user: AuthenticatedUser, @Body(new ZodBodyPipe(BundleRequestSchema)) body: BundleRequest): Promise<BundleCheckView> {
    return this.bundles.check(user.userId, body.text);
  }

  /** The file imported: all of it, or nothing when any of it has a problem. */
  @Post()
  save(@CurrentUser() user: AuthenticatedUser, @Body(new ZodBodyPipe(BundleRequestSchema)) body: BundleRequest): Promise<BundleCheckView> {
    return this.bundles.save(user.userId, body.text, body.example);
  }

  @Get("apps/:appId")
  exportApp(@CurrentUser() user: AuthenticatedUser, @Param("appId", ParseUUIDPipe) appId: string): Promise<BundleExportView> {
    return this.bundles.exportApp(user.userId, appId);
  }

  @Get("pipelines/:pipelineId")
  exportPipeline(
    @CurrentUser() user: AuthenticatedUser,
    @Param("pipelineId", ParseUUIDPipe) pipelineId: string,
  ): Promise<BundleExportView> {
    return this.bundles.exportPipeline(user.userId, pipelineId);
  }
}

import { Controller, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { PipelinesService } from "./pipelines.service";

/**
 * An App uninstalled: deleted with its pipelines, in one go. Here, not in AppsController, as the pipelines module
 * depends on the Apps module, not the other way round.
 */
@Controller("apps")
export class AppUninstallController {
  constructor(private readonly pipelines: PipelinesService) {}

  /** 409 while a run of one of its pipelines is going, or while something outside the App starts one of them. */
  @Post(":appId/uninstall")
  @HttpCode(204)
  uninstall(@CurrentUser() user: AuthenticatedUser, @Param("appId", ParseUUIDPipe) appId: string): Promise<void> {
    return this.pipelines.uninstallApp(user.userId, appId);
  }
}

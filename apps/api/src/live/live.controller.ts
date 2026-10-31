import { type LiveView } from "@ai-me/shared";
import { Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, StreamableFile } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { LiveService, type TakeoverListItem } from "./live.service";

@Controller()
export class LiveController {
  constructor(private readonly live: LiveService) {}

  @Get("runs/:runId/live")
  view(@CurrentUser() user: AuthenticatedUser, @Param("runId", ParseUUIDPipe) runId: string): Promise<LiveView> {
    return this.live.live(user.userId, runId);
  }

  @Post("runs/:runId/takeover")
  @HttpCode(204)
  takeOver(@CurrentUser() user: AuthenticatedUser, @Param("runId", ParseUUIDPipe) runId: string): Promise<void> {
    return this.live.takeOver(user.userId, runId);
  }

  @Post("runs/:runId/continue")
  @HttpCode(204)
  continue(@CurrentUser() user: AuthenticatedUser, @Param("runId", ParseUUIDPipe) runId: string): Promise<void> {
    return this.live.resolve(user.userId, runId, "CONTINUED");
  }

  @Post("runs/:runId/abort")
  @HttpCode(204)
  abort(@CurrentUser() user: AuthenticatedUser, @Param("runId", ParseUUIDPipe) runId: string): Promise<void> {
    return this.live.resolve(user.userId, runId, "ABORTED");
  }

  @Get("takeovers")
  waiting(@CurrentUser() user: AuthenticatedUser): Promise<TakeoverListItem[]> {
    return this.live.waiting(user.userId);
  }

  /** Caddy asks this before passing a /vnc connection on (forward_auth): signed in or not. */
  @Get("live/authorize")
  @HttpCode(204)
  authorize(): void {}

  /** Downloaded, never shown inline: a page or trace from a site is not to run in this origin. */
  @Get("artifacts/:artifactId")
  @Header("Content-Security-Policy", "sandbox")
  @Header("X-Content-Type-Options", "nosniff")
  async artifact(@CurrentUser() user: AuthenticatedUser, @Param("artifactId", ParseUUIDPipe) artifactId: string): Promise<StreamableFile> {
    const file = await this.live.artifact(user.userId, artifactId);
    const inline = file.mime.startsWith("image/");
    return new StreamableFile(file.stream, {
      type: file.mime,
      length: file.size,
      disposition: `${inline ? "inline" : "attachment"}; filename="${file.name.replace(/[^\w.-]/g, "_")}"`,
    });
  }
}

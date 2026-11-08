import {
  BuilderChatFilterSchema,
  BuilderMessageSchema,
  CreateBuilderChatSchema,
  type BuilderChatFilter,
  type BuilderChatSummaryView,
  type BuilderChatView,
  type BuilderDryRunResponse,
  type BuilderMessageRequest,
  type CreateBuilderChatRequest,
} from "@realentity/storm-shared";
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { BuilderService } from "./builder.service";

@Controller("builder/chats")
export class BuilderController {
  constructor(private readonly builder: BuilderService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodBodyPipe(BuilderChatFilterSchema)) filter: BuilderChatFilter,
  ): Promise<BuilderChatSummaryView[]> {
    return this.builder.list(user.userId, filter);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(CreateBuilderChatSchema)) body: CreateBuilderChatRequest,
  ): Promise<BuilderChatView> {
    return this.builder.create(user.userId, body.pipelineId, body.appId);
  }

  @Get(":chatId")
  get(@CurrentUser() user: AuthenticatedUser, @Param("chatId", ParseUUIDPipe) chatId: string): Promise<BuilderChatView> {
    return this.builder.get(user.userId, chatId);
  }

  /**
   * Runs one builder turn and answers when it is done (Opus: tens of seconds). Cost is bounded by one turn at a time
   * per chat and the per-chat token cap.
   */
  @Post(":chatId/messages")
  @HttpCode(200)
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Param("chatId", ParseUUIDPipe) chatId: string,
    @Body(new ZodBodyPipe(BuilderMessageSchema)) body: BuilderMessageRequest,
  ): Promise<BuilderChatView> {
    return this.builder.send(user.userId, chatId, body);
  }

  @Post(":chatId/messages/:messageId/save")
  @HttpCode(200)
  save(
    @CurrentUser() user: AuthenticatedUser,
    @Param("chatId", ParseUUIDPipe) chatId: string,
    @Param("messageId", ParseUUIDPipe) messageId: string,
  ): Promise<BuilderChatView> {
    return this.builder.save(user.userId, chatId, messageId);
  }

  /** M34: an App proposal saved: the App and its pipelines. */
  @Post(":chatId/messages/:messageId/save-app")
  saveApp(
    @CurrentUser() user: AuthenticatedUser,
    @Param("chatId", ParseUUIDPipe) chatId: string,
    @Param("messageId", ParseUUIDPipe) messageId: string,
  ): Promise<BuilderChatView> {
    return this.builder.saveApp(user.userId, chatId, messageId);
  }

  @Post(":chatId/messages/:messageId/dry-run")
  @HttpCode(202)
  dryRun(
    @CurrentUser() user: AuthenticatedUser,
    @Param("chatId", ParseUUIDPipe) chatId: string,
    @Param("messageId", ParseUUIDPipe) messageId: string,
  ): Promise<BuilderDryRunResponse> {
    return this.builder.dryRun(user.userId, chatId, messageId);
  }
}

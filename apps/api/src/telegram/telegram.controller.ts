import {
  TelegramConnectionSchema,
  type TelegramCommandsView,
  type TelegramConnectionRequest,
  type TelegramConnectionSaved,
  type TelegramConnectionView,
  type TelegramTestView,
} from "@realentity/storm-shared";
import { Body, Controller, Delete, Get, HttpCode, Post, Put } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { TelegramCommands } from "./telegram-commands";
import { TelegramConnection } from "./telegram-connection.service";

/** The Storm bot as Settings shows it. */
@Controller("telegram")
export class TelegramController {
  constructor(
    private readonly commands: TelegramCommands,
    private readonly connection: TelegramConnection,
  ) {}

  /** M49: every command, Storm's own and the pipelines' (off ones too). */
  @Get("commands")
  list(@CurrentUser() user: AuthenticatedUser): Promise<TelegramCommandsView> {
    return this.commands.list(user.userId);
  }

  /** M63: the bot's token (only its hint), your chat id, the webhook. */
  @Get("connection")
  get(@CurrentUser() user: AuthenticatedUser): Promise<TelegramConnectionView> {
    return this.connection.get(user.userId);
  }

  @Put("connection")
  save(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(TelegramConnectionSchema)) body: TelegramConnectionRequest,
  ): Promise<TelegramConnectionSaved> {
    return this.connection.save(user.userId, body);
  }

  @Post("connection/test")
  @HttpCode(200)
  test(@CurrentUser() user: AuthenticatedUser): Promise<TelegramTestView> {
    return this.connection.test(user.userId);
  }

  @Delete("connection")
  @HttpCode(204)
  remove(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.connection.remove(user.userId);
  }
}

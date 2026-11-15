import { type TelegramCommandsView } from "@realentity/storm-shared";
import { Controller, Get } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { TelegramCommands } from "./telegram-commands";

/** The Storm bot as Settings shows it. */
@Controller("telegram")
export class TelegramController {
  constructor(private readonly commands: TelegramCommands) {}

  /** M49: every command, Storm's own and the pipelines' (off ones too). */
  @Get("commands")
  list(@CurrentUser() user: AuthenticatedUser): Promise<TelegramCommandsView> {
    return this.commands.list(user.userId);
  }
}

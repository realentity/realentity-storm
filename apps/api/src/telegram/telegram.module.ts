import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { sealKeysProvider } from "../config/server-env";
import { TelegramCommands } from "./telegram-commands";
import { TelegramConnection } from "./telegram-connection.service";
import { TelegramController } from "./telegram.controller";
import { TELEGRAM_FETCH, TelegramNotices } from "./telegram-notices";

/**
 * The Storm bot's messages about proposals, its commands' registry (M49) and its connection (M63, Settings →
 * Telegram); the bot itself is in HooksModule, which receives its updates.
 */
@Module({
  imports: [AuthModule],
  controllers: [TelegramController],
  providers: [TelegramNotices, TelegramCommands, TelegramConnection, sealKeysProvider, { provide: TELEGRAM_FETCH, useValue: fetch }],
  exports: [TelegramNotices, TelegramCommands],
})
export class TelegramModule {}

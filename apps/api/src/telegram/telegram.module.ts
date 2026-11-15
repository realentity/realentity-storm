import { Module } from "@nestjs/common";
import { TelegramCommands } from "./telegram-commands";
import { TelegramController } from "./telegram.controller";
import { TELEGRAM_FETCH, TelegramNotices } from "./telegram-notices";

/**
 * The Storm bot's messages about proposals, and its commands' registry (M49); the bot itself is in HooksModule, which
 * receives its updates.
 */
@Module({
  controllers: [TelegramController],
  providers: [TelegramNotices, TelegramCommands, { provide: TELEGRAM_FETCH, useValue: fetch }],
  exports: [TelegramNotices, TelegramCommands],
})
export class TelegramModule {}

import { Module } from "@nestjs/common";
import { TELEGRAM_FETCH, TelegramNotices } from "./telegram-notices";

/** The AI ME bot's messages about proposals (the bot itself is in HooksModule, which receives its updates). */
@Module({
  providers: [TelegramNotices, { provide: TELEGRAM_FETCH, useValue: fetch }],
  exports: [TelegramNotices],
})
export class TelegramModule {}

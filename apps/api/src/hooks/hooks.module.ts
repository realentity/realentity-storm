import { Module } from "@nestjs/common";
import { keyRingProvider } from "../config/server-env";
import { ControlsModule } from "../controls/controls.module";
import { FactsModule } from "../facts/facts.module";
import { ProposalsModule } from "../proposals/proposals.module";
import { RunsModule } from "../runs/runs.module";
import { TelegramBot } from "../telegram/telegram-bot";
import { TelegramModule } from "../telegram/telegram.module";
import { HooksController, WebhooksController } from "./hooks.controller";
import { WebhooksService } from "./webhooks.service";

@Module({
  imports: [ControlsModule, FactsModule, ProposalsModule, RunsModule, TelegramModule],
  controllers: [HooksController, WebhooksController],
  providers: [TelegramBot, WebhooksService, keyRingProvider],
})
export class HooksModule {}

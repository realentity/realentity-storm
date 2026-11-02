import { Module } from "@nestjs/common";
import { BuilderModule } from "../builder/builder.module";
import { keyRingProvider } from "../config/server-env";
import { ControlsModule } from "../controls/controls.module";
import { FactsModule } from "../facts/facts.module";
import { HealthModule } from "../health/health.module";
import { PipelinesModule } from "../pipelines/pipelines.module";
import { ProposalsModule } from "../proposals/proposals.module";
import { RunsModule } from "../runs/runs.module";
import { TelegramBot } from "../telegram/telegram-bot";
import { TelegramBuilder } from "../telegram/telegram-builder";
import { TelegramModule } from "../telegram/telegram.module";
import { HooksController, WebhooksController } from "./hooks.controller";
import { WebhooksService } from "./webhooks.service";

@Module({
  imports: [BuilderModule, ControlsModule, FactsModule, HealthModule, PipelinesModule, ProposalsModule, RunsModule, TelegramModule],
  controllers: [HooksController, WebhooksController],
  providers: [TelegramBot, TelegramBuilder, WebhooksService, keyRingProvider],
})
export class HooksModule {}

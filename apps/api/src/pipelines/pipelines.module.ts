import { Module } from "@nestjs/common";
import { AppsModule } from "../apps/apps.module";
import { BindingsModule } from "../bindings/bindings.module";
import { ControlsModule } from "../controls/controls.module";
import { RunsModule } from "../runs/runs.module";
import { TelegramModule } from "../telegram/telegram.module";
import { AppUninstallController } from "./app-uninstall.controller";
import { PipelinesController } from "./pipelines.controller";
import { PipelinesService } from "./pipelines.service";
import { ScheduledStartsController } from "./scheduled-starts.controller";

@Module({
  imports: [AppsModule, BindingsModule, ControlsModule, RunsModule, TelegramModule],
  controllers: [PipelinesController, ScheduledStartsController, AppUninstallController],
  providers: [PipelinesService],
  exports: [PipelinesService],
})
export class PipelinesModule {}

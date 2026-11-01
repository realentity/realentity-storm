import { Module } from "@nestjs/common";
import { ControlsModule } from "../controls/controls.module";
import { RunsModule } from "../runs/runs.module";
import { PipelinesController } from "./pipelines.controller";
import { PipelinesService } from "./pipelines.service";
import { ScheduledStartsController } from "./scheduled-starts.controller";

@Module({
  imports: [ControlsModule, RunsModule],
  controllers: [PipelinesController, ScheduledStartsController],
  providers: [PipelinesService],
  exports: [PipelinesService],
})
export class PipelinesModule {}

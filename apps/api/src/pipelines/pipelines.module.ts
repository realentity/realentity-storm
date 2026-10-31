import { Module } from "@nestjs/common";
import { ControlsModule } from "../controls/controls.module";
import { RunsModule } from "../runs/runs.module";
import { PipelinesController } from "./pipelines.controller";
import { PipelinesService } from "./pipelines.service";

@Module({
  imports: [ControlsModule, RunsModule],
  controllers: [PipelinesController],
  providers: [PipelinesService],
  exports: [PipelinesService],
})
export class PipelinesModule {}

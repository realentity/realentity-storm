import { Module } from "@nestjs/common";
import { PipelinesModule } from "../pipelines/pipelines.module";
import { RunsModule } from "../runs/runs.module";
import { JobsController } from "./jobs.controller";
import { InsightService } from "./insight.service";
import { JobsService, RecipesService } from "./jobs.service";

@Module({
  imports: [PipelinesModule, RunsModule],
  controllers: [JobsController],
  providers: [JobsService, RecipesService, InsightService],
})
export class JobsModule {}

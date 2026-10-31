import { Module } from "@nestjs/common";
import { PipelinesModule } from "../pipelines/pipelines.module";
import { RunsModule } from "../runs/runs.module";
import { JobsController } from "./jobs.controller";
import { JobsService, RecipesService } from "./jobs.service";

@Module({
  imports: [PipelinesModule, RunsModule],
  controllers: [JobsController],
  providers: [JobsService, RecipesService],
})
export class JobsModule {}

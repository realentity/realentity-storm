import { Module } from "@nestjs/common";
import { PipelinesModule } from "../pipelines/pipelines.module";
import { RunsModule } from "../runs/runs.module";
import { RecipesController } from "./recipes.controller";
import { RecipesService } from "./recipes.service";

@Module({
  imports: [PipelinesModule, RunsModule],
  controllers: [RecipesController],
  providers: [RecipesService],
})
export class RecipesModule {}

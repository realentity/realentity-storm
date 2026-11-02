import { Module } from "@nestjs/common";
import { FactsController, QuestionsController } from "./facts.controller";
import { FactsService } from "./facts.service";

@Module({
  controllers: [FactsController, QuestionsController],
  providers: [FactsService],
  exports: [FactsService],
})
export class FactsModule {}

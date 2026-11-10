import { Module } from "@nestjs/common";
import { ExamplesModule } from "../examples/examples.module";
import { TopicFactsService } from "./topic-facts.service";
import { TopicLinksService } from "./topic-links.service";
import { TopicUpkeepService } from "./topic-upkeep.service";
import { TopicChangesController, TopicFactsController, TopicLinksController, TopicsController } from "./topics.controller";
import { TopicsService } from "./topics.service";

@Module({
  imports: [ExamplesModule],
  controllers: [TopicsController, TopicLinksController, TopicFactsController, TopicChangesController],
  providers: [TopicsService, TopicLinksService, TopicFactsService, TopicUpkeepService],
  exports: [TopicsService],
})
export class TopicsModule {}

import { Module } from "@nestjs/common";
import { ExamplesModule } from "../examples/examples.module";
import { TopicBackfillsService } from "./topic-backfills.service";
import { TopicFactsService } from "./topic-facts.service";
import { TopicLinksService } from "./topic-links.service";
import { TopicSourcesService } from "./topic-sources.service";
import { TopicUpkeepService } from "./topic-upkeep.service";
import {
  TopicBackfillsController,
  TopicChangesController,
  TopicFactsController,
  TopicLinksController,
  TopicsController,
  TopicSourcesController,
} from "./topics.controller";
import { TopicsService } from "./topics.service";

@Module({
  imports: [ExamplesModule],
  controllers: [
    TopicsController,
    TopicLinksController,
    TopicFactsController,
    TopicChangesController,
    TopicSourcesController,
    TopicBackfillsController,
  ],
  providers: [TopicsService, TopicLinksService, TopicFactsService, TopicUpkeepService, TopicSourcesService, TopicBackfillsService],
  exports: [TopicsService],
})
export class TopicsModule {}

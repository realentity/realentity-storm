import { Module } from "@nestjs/common";
import { ExamplesModule } from "../examples/examples.module";
import { TopicBackfillsService } from "./topic-backfills.service";
import { TopicFactsService } from "./topic-facts.service";
import { TopicLinksService } from "./topic-links.service";
import { TopicSourcesService } from "./topic-sources.service";
import { TopicSuggestionsService } from "./topic-suggestions.service";
import { TopicUpkeepService } from "./topic-upkeep.service";
import {
  TopicBackfillsController,
  TopicChangesController,
  TopicFactsController,
  TopicLinksController,
  TopicsController,
  TopicSourcesController,
  TopicSuggestionsController,
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
    TopicSuggestionsController,
  ],
  providers: [
    TopicsService,
    TopicLinksService,
    TopicFactsService,
    TopicUpkeepService,
    TopicSourcesService,
    TopicBackfillsService,
    TopicSuggestionsService,
  ],
  exports: [TopicsService],
})
export class TopicsModule {}

import {
  ApplyTopicBackfillSchema,
  MergeTopicSchema,
  SplitTopicSchema,
  MoveTopicFactSchema,
  MoveTopicLinkSchema,
  TopicDirectionSchema,
  TopicFactNoLongerTrueSchema,
  TopicFactSchema,
  TopicBackfillSchema,
  TopicSchema,
  TopicSourceSchema,
  TopicUpdateSchema,
  type TopicBackfillView,
  type TopicChangeView,
  type TopicFactView,
  type TopicLinkView,
  type TopicSourceView,
  type TopicSuggestionView,
  type TopicUpkeepView,
  type TopicView,
} from "@realentity/storm-shared";
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import { type z } from "zod";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { TopicBackfillsService } from "./topic-backfills.service";
import { TopicFactsService } from "./topic-facts.service";
import { TopicLinksService } from "./topic-links.service";
import { TopicSourcesService } from "./topic-sources.service";
import { TopicSuggestionsService } from "./topic-suggestions.service";
import { TopicUpkeepService } from "./topic-upkeep.service";
import { TopicsService } from "./topics.service";

/** Topics and their directions (M41-T2) on the Topics page. */
@Controller("topics")
export class TopicsController {
  constructor(
    private readonly topics: TopicsService,
    private readonly topicLinks: TopicLinksService,
    private readonly facts: TopicFactsService,
    private readonly upkeep: TopicUpkeepService,
    private readonly sources: TopicSourcesService,
    private readonly backfills: TopicBackfillsService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<TopicView[]> {
    return this.topics.list(user.userId);
  }

  /** Whether a pipeline keeps the topics' memory up to date (M42), and what it still needs. */
  @Get("upkeep")
  upkeepStatus(@CurrentUser() user: AuthenticatedUser): Promise<TopicUpkeepView> {
    return this.upkeep.status(user.userId);
  }

  @Get(":topicId/sources")
  topicSources(@CurrentUser() user: AuthenticatedUser, @Param("topicId", ParseUUIDPipe) topicId: string): Promise<TopicSourceView[]> {
    return this.sources.list(user.userId, topicId);
  }

  @Post(":topicId/sources")
  addSource(
    @CurrentUser() user: AuthenticatedUser,
    @Param("topicId", ParseUUIDPipe) topicId: string,
    @Body(new ZodBodyPipe(TopicSourceSchema)) body: z.output<typeof TopicSourceSchema>,
  ): Promise<TopicSourceView> {
    return this.sources.add(user.userId, topicId, body);
  }

  /** The topic's latest backfill (M43-T5), or null. */
  @Get(":topicId/backfill")
  backfill(@CurrentUser() user: AuthenticatedUser, @Param("topicId", ParseUUIDPipe) topicId: string): Promise<TopicBackfillView | null> {
    return this.backfills.latest(user.userId, topicId);
  }

  @Post(":topicId/backfill")
  estimateBackfill(
    @CurrentUser() user: AuthenticatedUser,
    @Param("topicId", ParseUUIDPipe) topicId: string,
    @Body(new ZodBodyPipe(TopicBackfillSchema)) body: z.output<typeof TopicBackfillSchema>,
  ): Promise<TopicBackfillView> {
    return this.backfills.estimate(user.userId, topicId, body);
  }

  @Get(":topicId/links")
  links(@CurrentUser() user: AuthenticatedUser, @Param("topicId", ParseUUIDPipe) topicId: string): Promise<TopicLinkView[]> {
    return this.topicLinks.ofTopic(user.userId, topicId);
  }

  @Get(":topicId/facts")
  topicFacts(@CurrentUser() user: AuthenticatedUser, @Param("topicId", ParseUUIDPipe) topicId: string): Promise<TopicFactView[]> {
    return this.facts.ofTopic(user.userId, topicId);
  }

  @Post(":topicId/facts")
  addFact(
    @CurrentUser() user: AuthenticatedUser,
    @Param("topicId", ParseUUIDPipe) topicId: string,
    @Body(new ZodBodyPipe(TopicFactSchema)) body: z.output<typeof TopicFactSchema>,
  ): Promise<TopicFactView> {
    return this.facts.add(user.userId, topicId, body);
  }

  @Post(":topicId/split")
  split(
    @CurrentUser() user: AuthenticatedUser,
    @Param("topicId", ParseUUIDPipe) topicId: string,
    @Body(new ZodBodyPipe(SplitTopicSchema)) body: z.output<typeof SplitTopicSchema>,
  ): Promise<{ topicId: string }> {
    return this.facts.split(user.userId, topicId, body);
  }

  @Post(":topicId/merge")
  @HttpCode(200)
  merge(
    @CurrentUser() user: AuthenticatedUser,
    @Param("topicId", ParseUUIDPipe) topicId: string,
    @Body(new ZodBodyPipe(MergeTopicSchema)) body: z.output<typeof MergeTopicSchema>,
  ): Promise<{ disputed: number }> {
    return this.facts.merge(user.userId, topicId, body.into);
  }

  @Get(":topicId/changes")
  changes(@CurrentUser() user: AuthenticatedUser, @Param("topicId", ParseUUIDPipe) topicId: string): Promise<TopicChangeView[]> {
    return this.facts.changes(user.userId, topicId);
  }

  @Get(":topicId")
  get(@CurrentUser() user: AuthenticatedUser, @Param("topicId", ParseUUIDPipe) topicId: string): Promise<TopicView> {
    return this.topics.get(user.userId, topicId);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodBodyPipe(TopicSchema)) body: z.output<typeof TopicSchema>,
  ): Promise<TopicView> {
    return this.topics.create(user.userId, body);
  }

  @Put(":topicId")
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("topicId", ParseUUIDPipe) topicId: string,
    @Body(new ZodBodyPipe(TopicUpdateSchema)) body: z.output<typeof TopicUpdateSchema>,
  ): Promise<TopicView> {
    return this.topics.update(user.userId, topicId, body);
  }

  @Delete(":topicId")
  @HttpCode(204)
  remove(@CurrentUser() user: AuthenticatedUser, @Param("topicId", ParseUUIDPipe) topicId: string): Promise<void> {
    return this.topics.remove(user.userId, topicId);
  }

  @Post(":topicId/directions")
  addDirection(
    @CurrentUser() user: AuthenticatedUser,
    @Param("topicId", ParseUUIDPipe) topicId: string,
    @Body(new ZodBodyPipe(TopicDirectionSchema)) body: z.output<typeof TopicDirectionSchema>,
  ): Promise<TopicView> {
    return this.topics.addDirection(user.userId, topicId, body);
  }

  @Delete(":topicId/directions/:directionId")
  removeDirection(
    @CurrentUser() user: AuthenticatedUser,
    @Param("topicId", ParseUUIDPipe) topicId: string,
    @Param("directionId", ParseUUIDPipe) directionId: string,
  ): Promise<TopicView> {
    return this.topics.removeDirection(user.userId, topicId, directionId);
  }
}

/** An email's topics (M41-T4): the queue of suggestions, and the user's confirm, reject and move. */
@Controller("topic-links")
export class TopicLinksController {
  constructor(private readonly links: TopicLinksService) {}

  @Get("waiting")
  waiting(@CurrentUser() user: AuthenticatedUser): Promise<TopicLinkView[]> {
    return this.links.waiting(user.userId);
  }

  @Post(":topicLinkId/confirm")
  @HttpCode(200)
  confirm(@CurrentUser() user: AuthenticatedUser, @Param("topicLinkId", ParseUUIDPipe) topicLinkId: string): Promise<TopicLinkView> {
    return this.links.confirm(user.userId, topicLinkId);
  }

  @Post(":topicLinkId/reject")
  @HttpCode(200)
  reject(@CurrentUser() user: AuthenticatedUser, @Param("topicLinkId", ParseUUIDPipe) topicLinkId: string): Promise<TopicLinkView> {
    return this.links.reject(user.userId, topicLinkId);
  }

  @Post(":topicLinkId/move")
  @HttpCode(200)
  move(
    @CurrentUser() user: AuthenticatedUser,
    @Param("topicLinkId", ParseUUIDPipe) topicLinkId: string,
    @Body(new ZodBodyPipe(MoveTopicLinkSchema)) body: z.output<typeof MoveTopicLinkSchema>,
  ): Promise<TopicLinkView> {
    return this.links.move(user.userId, topicLinkId, body.topicId);
  }
}

/** A topic's facts (M42-T1): the user's changes, each recorded with why, and undo. */
@Controller("topic-facts")
export class TopicFactsController {
  constructor(private readonly facts: TopicFactsService) {}

  @Put(":topicFactId")
  edit(
    @CurrentUser() user: AuthenticatedUser,
    @Param("topicFactId", ParseUUIDPipe) topicFactId: string,
    @Body(new ZodBodyPipe(TopicFactSchema)) body: z.output<typeof TopicFactSchema>,
  ): Promise<TopicFactView> {
    return this.facts.edit(user.userId, topicFactId, body);
  }

  @Post(":topicFactId/no-longer-true")
  @HttpCode(200)
  noLongerTrue(
    @CurrentUser() user: AuthenticatedUser,
    @Param("topicFactId", ParseUUIDPipe) topicFactId: string,
    @Body(new ZodBodyPipe(TopicFactNoLongerTrueSchema)) body: z.output<typeof TopicFactNoLongerTrueSchema>,
  ): Promise<TopicFactView> {
    return this.facts.noLongerTrue(user.userId, topicFactId, body.statement);
  }

  @Post(":topicFactId/wrong")
  @HttpCode(204)
  wrong(@CurrentUser() user: AuthenticatedUser, @Param("topicFactId", ParseUUIDPipe) topicFactId: string): Promise<void> {
    return this.facts.wrong(user.userId, topicFactId);
  }

  @Post(":topicFactId/settle")
  @HttpCode(200)
  settle(@CurrentUser() user: AuthenticatedUser, @Param("topicFactId", ParseUUIDPipe) topicFactId: string): Promise<TopicFactView> {
    return this.facts.settle(user.userId, topicFactId);
  }

  @Post(":topicFactId/move")
  @HttpCode(200)
  move(
    @CurrentUser() user: AuthenticatedUser,
    @Param("topicFactId", ParseUUIDPipe) topicFactId: string,
    @Body(new ZodBodyPipe(MoveTopicFactSchema)) body: z.output<typeof MoveTopicFactSchema>,
  ): Promise<TopicFactView> {
    return this.facts.move(user.userId, topicFactId, body.topicId);
  }
}

/** Undo a change to a topic's facts (M42-T1). */
@Controller("topic-changes")
export class TopicChangesController {
  constructor(private readonly facts: TopicFactsService) {}

  @Post(":topicChangeId/undo")
  @HttpCode(204)
  undo(@CurrentUser() user: AuthenticatedUser, @Param("topicChangeId", ParseUUIDPipe) topicChangeId: string): Promise<void> {
    return this.facts.undo(user.userId, topicChangeId);
  }
}

/** A topic's sources (M43): removed, or its index rebuilt. */
@Controller("topic-sources")
export class TopicSourcesController {
  constructor(private readonly sources: TopicSourcesService) {}

  @Delete(":topicSourceId")
  @HttpCode(204)
  remove(@CurrentUser() user: AuthenticatedUser, @Param("topicSourceId", ParseUUIDPipe) topicSourceId: string): Promise<void> {
    return this.sources.remove(user.userId, topicSourceId);
  }

  @Post(":topicSourceId/rebuild")
  @HttpCode(200)
  rebuild(@CurrentUser() user: AuthenticatedUser, @Param("topicSourceId", ParseUUIDPipe) topicSourceId: string): Promise<TopicSourceView> {
    return this.sources.rebuild(user.userId, topicSourceId);
  }
}

/** A topic's backfill (M43-T5): started after its estimate, cancelled, its proposals applied. */
@Controller("topic-backfills")
export class TopicBackfillsController {
  constructor(private readonly backfills: TopicBackfillsService) {}

  @Post(":topicBackfillId/start")
  @HttpCode(200)
  start(
    @CurrentUser() user: AuthenticatedUser,
    @Param("topicBackfillId", ParseUUIDPipe) topicBackfillId: string,
  ): Promise<TopicBackfillView> {
    return this.backfills.start(user.userId, topicBackfillId);
  }

  @Post(":topicBackfillId/cancel")
  @HttpCode(200)
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param("topicBackfillId", ParseUUIDPipe) topicBackfillId: string,
  ): Promise<TopicBackfillView> {
    return this.backfills.cancel(user.userId, topicBackfillId);
  }

  @Post(":topicBackfillId/apply")
  @HttpCode(200)
  apply(
    @CurrentUser() user: AuthenticatedUser,
    @Param("topicBackfillId", ParseUUIDPipe) topicBackfillId: string,
    @Body(new ZodBodyPipe(ApplyTopicBackfillSchema)) body: z.output<typeof ApplyTopicBackfillSchema>,
  ): Promise<TopicBackfillView> {
    return this.backfills.apply(user.userId, topicBackfillId, body.picked);
  }
}

/** What Storm suggests for topics (M44): accepted or dismissed by the user. */
@Controller("topic-suggestions")
export class TopicSuggestionsController {
  constructor(private readonly suggestions: TopicSuggestionsService) {}

  @Get()
  open(@CurrentUser() user: AuthenticatedUser): Promise<TopicSuggestionView[]> {
    return this.suggestions.open(user.userId);
  }

  @Post(":topicSuggestionId/accept")
  @HttpCode(200)
  accept(@CurrentUser() user: AuthenticatedUser, @Param("topicSuggestionId", ParseUUIDPipe) id: string): Promise<TopicSuggestionView> {
    return this.suggestions.accept(user.userId, id);
  }

  @Post(":topicSuggestionId/dismiss")
  @HttpCode(200)
  dismiss(@CurrentUser() user: AuthenticatedUser, @Param("topicSuggestionId", ParseUUIDPipe) id: string): Promise<TopicSuggestionView> {
    return this.suggestions.dismiss(user.userId, id);
  }
}

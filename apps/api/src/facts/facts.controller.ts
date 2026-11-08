import {
  AnswerQuestionSchema,
  FactSchema,
  type AnswerQuestionRequest,
  type FactRequest,
  type FactView,
  type QuestionView,
} from "@realentity/storm-shared";
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { FactsService } from "./facts.service";

/** My facts (M15-T1) on the Profile page. */
@Controller("facts")
export class FactsController {
  constructor(private readonly facts: FactsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<FactView[]> {
    return this.facts.list(user.userId);
  }

  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body(new ZodBodyPipe(FactSchema)) body: FactRequest): Promise<FactView> {
    return this.facts.create(user.userId, body);
  }

  @Put(":factId")
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("factId", ParseUUIDPipe) factId: string,
    @Body(new ZodBodyPipe(FactSchema)) body: FactRequest,
  ): Promise<FactView> {
    return this.facts.update(user.userId, factId, body);
  }

  @Delete(":factId")
  @HttpCode(204)
  remove(@CurrentUser() user: AuthenticatedUser, @Param("factId", ParseUUIDPipe) factId: string): Promise<void> {
    return this.facts.remove(user.userId, factId);
  }
}

/** Answering what a run asked me (M15-T3), on its page. */
@Controller("questions")
export class QuestionsController {
  constructor(private readonly facts: FactsService) {}

  @Post(":questionId/answer")
  @HttpCode(200)
  answer(
    @CurrentUser() user: AuthenticatedUser,
    @Param("questionId", ParseUUIDPipe) questionId: string,
    @Body(new ZodBodyPipe(AnswerQuestionSchema)) body: AnswerQuestionRequest,
  ): Promise<QuestionView> {
    return this.facts.answer(user.userId, questionId, body.answer);
  }
}

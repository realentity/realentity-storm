import {
  CreateRuleSchema,
  UpdateRuleSchema,
  UpdateSuggestionSchema,
  type CreateRuleRequest,
  type LearningView,
  type RuleView,
  type UpdateRuleRequest,
  type UpdateSuggestionRequest,
} from "@realentity/storm-shared";
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { LearningService } from "./learning.service";

@Controller()
export class LearningController {
  constructor(private readonly learning: LearningService) {}

  @Get("learning")
  view(@CurrentUser() user: AuthenticatedUser): Promise<LearningView> {
    return this.learning.view(user.userId);
  }

  @Post("rules")
  createRule(@CurrentUser() user: AuthenticatedUser, @Body(new ZodBodyPipe(CreateRuleSchema)) body: CreateRuleRequest): Promise<RuleView> {
    return this.learning.createRule(user.userId, body);
  }

  @Patch("rules/:ruleId")
  updateRule(
    @CurrentUser() user: AuthenticatedUser,
    @Param("ruleId", ParseUUIDPipe) ruleId: string,
    @Body(new ZodBodyPipe(UpdateRuleSchema)) body: UpdateRuleRequest,
  ): Promise<RuleView> {
    return this.learning.updateRule(user.userId, ruleId, body);
  }

  @Delete("rules/:ruleId")
  @HttpCode(204)
  deleteRule(@CurrentUser() user: AuthenticatedUser, @Param("ruleId", ParseUUIDPipe) ruleId: string): Promise<void> {
    return this.learning.deleteRule(user.userId, ruleId);
  }

  @Patch("suggestions/:suggestionId")
  @HttpCode(204)
  updateSuggestion(
    @CurrentUser() user: AuthenticatedUser,
    @Param("suggestionId", ParseUUIDPipe) suggestionId: string,
    @Body(new ZodBodyPipe(UpdateSuggestionSchema)) body: UpdateSuggestionRequest,
  ): Promise<void> {
    return this.learning.updateSuggestion(user.userId, suggestionId, body.status);
  }

  @Post("reflection")
  @HttpCode(202)
  requestReflection(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.learning.requestReflection(user.userId);
  }
}

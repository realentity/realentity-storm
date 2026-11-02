import {
  ImportRecipeSchema,
  JobFilterSchema,
  TeachRecipeSchema,
  UpdateApplicationSchema,
  UpdateJobSchema,
  type ApplicationView,
  type ImportRecipeRequest,
  type InsightView,
  type JobFilter,
  type JobPostingView,
  type RecipeDetailView,
  type RecipeSummaryView,
  type TeachRecipeRequest,
  type TeachStartedView,
  type UpdateApplicationRequest,
  type UpdateJobRequest,
} from "@ai-me/shared";
import { z } from "zod";
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { InsightService } from "./insight.service";
import { JobsService, RecipesService } from "./jobs.service";

const InsightQuerySchema = z.object({ days: z.coerce.number().int().min(7).max(730).default(90) }).strict();

@Controller()
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly recipes: RecipesService,
    private readonly insights: InsightService,
  ) {}

  /** Best score first. */
  @Get("jobs")
  list(@CurrentUser() user: AuthenticatedUser, @Query(new ZodBodyPipe(JobFilterSchema)) filter: JobFilter): Promise<JobPostingView[]> {
    return this.jobs.list(user.userId, filter);
  }

  @Patch("jobs/:jobPostingId")
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("jobPostingId", ParseUUIDPipe) jobPostingId: string,
    @Body(new ZodBodyPipe(UpdateJobSchema)) body: UpdateJobRequest,
  ): Promise<JobPostingView> {
    return this.jobs.update(user.userId, jobPostingId, body);
  }

  /** The job-search dashboard (M16-T1): the postings found in the last `days` and what came of them. */
  @Get("insight")
  insight(@CurrentUser() user: AuthenticatedUser, @Query(new ZodBodyPipe(InsightQuerySchema)) query: z.infer<typeof InsightQuerySchema>): Promise<InsightView> {
    return this.insights.insight(user.userId, query.days);
  }

  /** An application's outcome by hand (M16-T3): replied, interview, rejected. */
  @Patch("applications/:applicationId")
  updateApplication(
    @CurrentUser() user: AuthenticatedUser,
    @Param("applicationId", ParseUUIDPipe) applicationId: string,
    @Body(new ZodBodyPipe(UpdateApplicationSchema)) body: UpdateApplicationRequest,
  ): Promise<ApplicationView> {
    return this.insights.updateApplication(user.userId, applicationId, body);
  }

  @Get("recipes")
  recipesList(@CurrentUser() user: AuthenticatedUser): Promise<RecipeSummaryView[]> {
    return this.recipes.list(user.userId);
  }

  /** `name` is "<site>/<what>": the path has both segments. */
  @Get("recipes/:site/:what")
  recipe(@CurrentUser() user: AuthenticatedUser, @Param("site") site: string, @Param("what") what: string): Promise<RecipeDetailView> {
    return this.recipes.get(user.userId, `${site}/${what}`);
  }

  /** M11-T3: the agent's fix for the broken latest version becomes the next version. */
  @Post("recipes/:site/:what/fix")
  @HttpCode(200)
  approveFix(@CurrentUser() user: AuthenticatedUser, @Param("site") site: string, @Param("what") what: string): Promise<RecipeDetailView> {
    return this.recipes.approveFix(user.userId, `${site}/${what}`);
  }

  @Delete("recipes/:site/:what/fix")
  discardFix(@CurrentUser() user: AuthenticatedUser, @Param("site") site: string, @Param("what") what: string): Promise<RecipeDetailView> {
    return this.recipes.discardFix(user.userId, `${site}/${what}`);
  }

  @Post("recipes")
  import(@CurrentUser() user: AuthenticatedUser, @Body(new ZodBodyPipe(ImportRecipeSchema)) body: ImportRecipeRequest): Promise<RecipeDetailView> {
    return this.recipes.import(user.userId, body);
  }

  @Post("recipes/teach")
  teach(@CurrentUser() user: AuthenticatedUser, @Body(new ZodBodyPipe(TeachRecipeSchema)) body: TeachRecipeRequest): Promise<TeachStartedView> {
    return this.recipes.teach(user.userId, body);
  }
}

import {
  ImportRecipeSchema,
  JobFilterSchema,
  TeachRecipeSchema,
  UpdateJobSchema,
  type ImportRecipeRequest,
  type JobFilter,
  type JobPostingView,
  type RecipeDetailView,
  type RecipeSummaryView,
  type TeachRecipeRequest,
  type TeachStartedView,
  type UpdateJobRequest,
} from "@ai-me/shared";
import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { JobsService, RecipesService } from "./jobs.service";

@Controller()
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly recipes: RecipesService,
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

  @Get("recipes")
  recipesList(@CurrentUser() user: AuthenticatedUser): Promise<RecipeSummaryView[]> {
    return this.recipes.list(user.userId);
  }

  /** `name` is "<site>/<what>": the path has both segments. */
  @Get("recipes/:site/:what")
  recipe(@CurrentUser() user: AuthenticatedUser, @Param("site") site: string, @Param("what") what: string): Promise<RecipeDetailView> {
    return this.recipes.get(user.userId, `${site}/${what}`);
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

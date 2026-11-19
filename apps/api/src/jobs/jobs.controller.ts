import {
  ImportRecipeSchema,
  JobFilterSchema,
  TeachRecipeSchema,
  TryRecipeSchema,
  UpdateApplicationSchema,
  UpdateJobSchema,
  type ApplicationView,
  type ImportRecipeRequest,
  type JobFilter,
  type JobPostingView,
  type RecipeDetailView,
  type RecipeSummaryView,
  type TeachRecipeRequest,
  type TeachStartedView,
  type TryRecipeRequest,
  type UpdateApplicationRequest,
  type UpdateJobRequest,
} from "@realentity/storm-shared";
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
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

  /** An application's outcome by hand (M16-T3): replied, interview, rejected. */
  @Patch("applications/:applicationId")
  updateApplication(
    @CurrentUser() user: AuthenticatedUser,
    @Param("applicationId", ParseUUIDPipe) applicationId: string,
    @Body(new ZodBodyPipe(UpdateApplicationSchema)) body: UpdateApplicationRequest,
  ): Promise<ApplicationView> {
    return this.jobs.updateApplication(user.userId, applicationId, body);
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

  /** Try: a dry run that reads the list with the latest version and changes nothing; the run page has what it read. */
  @Post("recipes/:site/:what/try")
  try(
    @CurrentUser() user: AuthenticatedUser,
    @Param("site") site: string,
    @Param("what") what: string,
    @Body(new ZodBodyPipe(TryRecipeSchema)) body: TryRecipeRequest,
  ): Promise<TeachStartedView> {
    return this.recipes.try(user.userId, `${site}/${what}`, body);
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

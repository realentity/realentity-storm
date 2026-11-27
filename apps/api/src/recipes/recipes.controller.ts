import {
  ImportRecipeSchema,
  TeachRecipeSchema,
  TryRecipeSchema,
  type ImportRecipeRequest,
  type RecipeDetailView,
  type RecipeSummaryView,
  type TeachRecipeRequest,
  type TeachStartedView,
  type TryRecipeRequest,
} from "@realentity/storm-shared";
import { Body, Controller, Delete, Get, HttpCode, Param, Post } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { ZodBodyPipe } from "../common/zod-body.pipe";
import { RecipesService } from "./recipes.service";

@Controller()
export class RecipesController {
  constructor(private readonly recipes: RecipesService) {}

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

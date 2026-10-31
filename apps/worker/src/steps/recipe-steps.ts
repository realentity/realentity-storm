import { type PrismaClient, type SiteRecipe } from "@ai-me/db";
import { recipeProblems, RecipeSchema, siteOf, type Recipe } from "@ai-me/steps";
import { type Page } from "playwright";
import { type ArtifactOwner } from "../browser/artifact-store";
import { readList, RecipeBroken, type Item } from "../browser/recipe-runner";
import { NO_ATTENTION, type StepContext, type StepExecutor } from "../runner/step-executor";
import { type BrowserDependencies } from "./browser-steps";

/** One search per combination of list params, at most this many per step. */
const MAX_SEARCHES = 10;

interface ExtractInput {
  recipes: string[];
  params: Record<string, string | string[]>;
  maxItems: number;
  timeoutSeconds: number;
}

/** The latest version of a recipe, checked; a missing or invalid one fails the step with what to do. */
export async function latestRecipe(prisma: PrismaClient, userId: string, name: string): Promise<{ row: SiteRecipe; recipe: Recipe }> {
  const row = await prisma.siteRecipe.findFirst({ where: { userId, name }, orderBy: { version: "desc" } });
  if (!row) throw new Error(`There is no recipe "${name}" yet: teach it or import it on the Recipes page`);
  const parsed = RecipeSchema.safeParse(row.steps);
  const problems = parsed.success ? recipeProblems(name, parsed.data) : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  if (!parsed.success || problems.length > 0) throw new Error(`Recipe ${name} v${row.version} is not valid: ${problems.join("; ")}`);
  return { row, recipe: parsed.data };
}

/** Every combination of the params' values: { city: ["Sofia", "Remote"] } → two searches. */
export function searches(params: Record<string, string | string[]>): Record<string, string>[] {
  let combinations: Record<string, string>[] = [{}];
  for (const [name, value] of Object.entries(params)) {
    const values = Array.isArray(value) ? value : [value];
    combinations = combinations.flatMap((combination) => values.map((v) => ({ ...combination, [name]: v })));
  }
  if (combinations.length > MAX_SEARCHES) throw new Error(`${combinations.length} searches; at most ${MAX_SEARCHES} per step`);
  return combinations;
}

/**
 * browser.extract (README §2.4): a list read with saved recipes, headless and without an LLM. A recipe that no longer
 * matches the page fails the step with what didn't match, is marked broken and I get a Telegram message the first
 * time (M9-T7); one that works is marked verified.
 */
export class BrowserExtractStep implements StepExecutor {
  readonly type = "browser.extract";

  constructor(
    private readonly deps: BrowserDependencies,
    private readonly delay?: (ms: number) => Promise<void>,
  ) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { recipes, params, maxItems, timeoutSeconds } = input as unknown as ExtractInput;
    const combinations = searches(params);
    const items: Item[] = [];
    const keys = new Set<string>();
    let pages = 0;

    for (const name of recipes) {
      const { row, recipe } = await latestRecipe(this.deps.prisma, context.userId, name);
      const storageState = await this.deps.sessions.load(context.userId, siteOf(name));
      const lease = await this.deps.pool.lease(false, { storageState, acceptDownloads: false });
      try {
        const page = await lease.context.newPage();
        page.setDefaultTimeout(timeoutSeconds * 1000);
        try {
          for (const values of combinations) {
            const result = await readList(page, name, recipe, {
              values,
              maxItems: maxItems - items.length,
              timeout: timeoutSeconds * 1000,
              attention: NO_ATTENTION,
              delay: this.delay,
            });
            pages += result.pages;
            for (const item of result.items) {
              const key = `${name} ${item[recipe.key]}`;
              if (keys.has(key)) continue;
              keys.add(key);
              items.push({ ...item, source: name });
            }
            if (items.length >= maxItems) break;
          }
        } catch (error) {
          if (!(error instanceof RecipeBroken)) throw error;
          await this.screenshot(page, context).catch(() => undefined);
          await this.markBroken(row, error.message);
          throw new Error(`Recipe ${name} v${row.version} no longer matches the page: ${error.message}`);
        }
      } finally {
        await lease.close();
      }
      await this.deps.prisma.siteRecipe.update({
        where: { siteRecipeId: row.siteRecipeId },
        data: { lastVerifiedAt: new Date(), brokenAt: null, brokenReason: null },
      });
      if (items.length >= maxItems) break;
    }
    return { items, pages };
  }

  private async markBroken(row: SiteRecipe, reason: string): Promise<void> {
    await this.deps.prisma.siteRecipe.update({ where: { siteRecipeId: row.siteRecipeId }, data: { brokenAt: new Date(), brokenReason: reason } });
    // Once per breakage: the next failures of the same version say nothing new.
    if (!row.brokenAt) {
      await this.deps.notify?.(`AI ME: recipe ${row.name} v${row.version} is broken: ${reason}. Teach it again on the Recipes page.`).catch(() => undefined);
    }
  }

  private async screenshot(page: Page, context: StepContext): Promise<void> {
    const owner: ArtifactOwner = { userId: context.userId, runId: context.runId, stepKey: context.stepKey, itemIndex: context.itemIndex };
    const png = await page.screenshot({ fullPage: false, timeout: 10_000 });
    await this.deps.artifacts.save(this.deps.prisma, owner, "screenshot", png, "png", "image/png");
  }
}

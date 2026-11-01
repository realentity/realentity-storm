import { type SiteRecipe } from "@ai-me/db";
import { fillTemplate, recipeProblems, RecipeSchema, siteOf, type Recipe } from "@ai-me/steps";
import { type Page } from "playwright";
import { readList } from "../browser/recipe-runner";
import { NO_ATTENTION, type StepContext } from "../runner/step-executor";
import { type BrowserAgentStep } from "./agent-steps";
import { type BrowserDependencies } from "./browser-steps";
import { pageOutline, type RecipeWriter } from "./teach-step";

/** The agent finds the list in a few actions or not at all. */
const AGENT_ACTIONS = 10;

/**
 * browser.extract's fallback (README §2.4, M11-T3): when a recipe no longer matches its page, the fix already waiting
 * for me is tried first (no LLM); else browser.agent, on the recipe's site only and sending nothing, brings the page
 * back to the list, and the recipe writer (teach mode's) proposes a recipe checked on that page. The fix is saved on
 * the broken version as a proposal, never as a version: I approve it on the Recipes page. The run reads with it.
 */
export class RecipeFallback {
  constructor(
    private readonly deps: BrowserDependencies,
    private readonly agent: BrowserAgentStep,
    private readonly writer: RecipeWriter,
  ) {}

  /** A recipe that reads the list again, or an error saying why there is none. */
  async fix(context: StepContext, row: SiteRecipe, broken: Recipe, values: Record<string, string>, timeout: number): Promise<Recipe> {
    const waiting = RecipeSchema.safeParse(row.proposed);
    if (waiting.success && recipeProblems(row.name, waiting.data).length === 0 && (await this.reads(context, row.name, waiting.data, values, timeout))) {
      return waiting.data;
    }

    const site = siteOf(row.name);
    const storageState = await this.deps.sessions.load(context.userId, site);
    const lease = await this.deps.pool.lease(false, { storageState, acceptDownloads: false });
    try {
      let start: string;
      try {
        start = fillTemplate(broken.url, values, broken.params);
      } catch {
        start = `https://${site}/`;
      }
      const holder: { page?: Page } = {};
      const fields = Object.keys(broken.fields);
      await this.agent.workOn(
        lease.context,
        {
          url: start,
          goal:
            `Bring the page to the list that the recipe ${row.name} reads (${Object.keys(values).length ? `search: ${JSON.stringify(values)}` : "its first page"}), ` +
            `with its items showing (${fields.join(", ")}), then finish with outcome done. Don't open an item; read only.`,
          headed: false,
          documents: [],
          maxActions: AGENT_ACTIONS,
          timeoutSeconds: Math.round(timeout / 1000),
        },
        context,
        { allowedHosts: [site], attention: NO_ATTENTION },
        holder,
      );
      const page = holder.page!;
      const { recipe } = await this.writer.write(context, page, {
        name: row.name,
        params: values,
        fields,
        hint: `Version ${row.version} no longer matches the page; it was: ${JSON.stringify(broken)}. Keep its params and fields.`,
        outline: await pageOutline(page),
      });
      if (!context.dryRun) {
        await this.deps.prisma.siteRecipe.update({
          where: { siteRecipeId: row.siteRecipeId },
          data: { proposed: recipe, proposedAt: new Date(), proposedInRunId: context.runId },
        });
      }
      return recipe;
    } finally {
      await lease.close();
    }
  }

  /** Whether a recipe reads items from the page now (the first search). */
  private async reads(context: StepContext, name: string, recipe: Recipe, values: Record<string, string>, timeout: number): Promise<boolean> {
    const lease = await this.deps.pool.lease(false, { storageState: await this.deps.sessions.load(context.userId, siteOf(name)), acceptDownloads: false });
    try {
      const page = await lease.context.newPage();
      page.setDefaultTimeout(timeout);
      const { items } = await readList(page, name, { ...recipe, maxPages: 1 }, { values, maxItems: 5, timeout, attention: NO_ATTENTION });
      return items.length > 0;
    } catch {
      return false;
    } finally {
      await lease.close();
    }
  }
}

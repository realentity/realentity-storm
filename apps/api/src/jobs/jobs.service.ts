import { applicationView } from "./insight.service";
import { Prisma, type Application, type JobPosting, type SiteRecipe } from "@realentity/storm-db";
import {
  type ImportRecipeRequest,
  type JobFilter,
  type JobPostingView,
  type RecipeDetailView,
  type RecipeSummaryView,
  type RecipeVersionView,
  type TeachRecipeRequest,
  type TeachStartedView,
  type UpdateJobRequest,
} from "@realentity/storm-shared";
import { RECIPE_NAME, recipeProblems, RecipeSchema, siteOf } from "@realentity/storm-steps";
import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { parse as parseYaml } from "yaml";
import { PrismaService } from "../database/prisma.service";
import { PipelinesService } from "../pipelines/pipelines.service";
import { RunsService } from "../runs/runs.service";

/** The Jobs page (docs/design.md §11 Phase 2, M9-T6): postings saved by data.save, scored, and the user's decisions. */
@Injectable()
export class JobsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, filter: JobFilter): Promise<JobPostingView[]> {
    const where: Prisma.JobPostingWhereInput = {
      userId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.minScore !== undefined ? { score: { gte: filter.minScore } } : {}),
      ...(filter.q
        ? { OR: [{ title: { contains: filter.q, mode: "insensitive" } }, { company: { contains: filter.q, mode: "insensitive" } }] }
        : {}),
    };
    const postings = await this.prisma.client.jobPosting.findMany({
      where,
      orderBy: [{ score: { sort: "desc", nulls: "last" } }, { firstSeenAt: "desc" }],
      take: filter.limit,
      include: { applications: true },
    });
    return postings.map(jobView);
  }

  async update(userId: string, jobPostingId: string, body: UpdateJobRequest): Promise<JobPostingView> {
    const updated = await this.prisma.client.jobPosting.updateMany({ where: { jobPostingId, userId }, data: { status: body.status } });
    if (updated.count === 0) throw new NotFoundException();
    return jobView(await this.prisma.client.jobPosting.findUniqueOrThrow({ where: { jobPostingId }, include: { applications: true } }));
  }
}

/**
 * Site recipes (docs/design.md §2.4): listed with their health, imported as a new version (checked like a taught one), or
 * taught: teach mode is a run of a "Teach <name>" pipeline with one browser.teach step, so it has the run page's
 * live view, takeover and history like any other headed run.
 */
@Injectable()
export class RecipesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pipelines: PipelinesService,
    private readonly runs: RunsService,
  ) {}

  async list(userId: string): Promise<RecipeSummaryView[]> {
    const rows = await this.prisma.client.siteRecipe.findMany({ where: { userId }, orderBy: [{ name: "asc" }, { version: "desc" }] });
    const latest = new Map<string, SiteRecipe>();
    for (const row of rows) if (!latest.has(row.name)) latest.set(row.name, row);
    return [...latest.values()].map((row) => ({
      name: row.name,
      site: row.site,
      version: row.version,
      lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
      lastItemsAt: row.lastItemsAt?.toISOString() ?? null,
      quiet: row.quietToldAt !== null,
      brokenAt: row.brokenAt?.toISOString() ?? null,
      brokenReason: row.brokenReason,
      proposedAt: row.proposedAt?.toISOString() ?? null,
      dateCreated: row.dateCreated.toISOString(),
    }));
  }

  async get(userId: string, name: string): Promise<RecipeDetailView> {
    const rows = await this.prisma.client.siteRecipe.findMany({ where: { userId, name }, orderBy: { version: "desc" } });
    if (rows.length === 0) throw new NotFoundException();
    return { name, site: rows[0].site, versions: rows.map(versionView) };
  }

  async import(userId: string, body: ImportRecipeRequest): Promise<RecipeDetailView> {
    const name = checkedName(body.name);
    let parsed: unknown;
    try {
      parsed = parseYaml(body.source);
    } catch (error) {
      throw new BadRequestException(`Not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (parsed && typeof parsed === "object" && "steps" in parsed) {
      throw new BadRequestException(
        "This is a pipeline (it has steps): paste it on Pipelines → New pipeline. A recipe has url, item and fields, like recipes/example-jobs.yaml",
      );
    }
    const recipe = RecipeSchema.safeParse(parsed);
    if (!recipe.success) throw new BadRequestException(recipe.error.issues.map((i) => `${i.path.join(".") || "recipe"}: ${i.message}`).join("; "));
    const problems = recipeProblems(name, recipe.data);
    if (problems.length > 0) throw new BadRequestException(problems.join("; "));

    const latest = await this.prisma.client.siteRecipe.findFirst({ where: { userId, name }, orderBy: { version: "desc" } });
    await this.prisma.client.siteRecipe.create({
      data: { userId, name, site: siteOf(name), version: (latest?.version ?? 0) + 1, steps: recipe.data },
    });
    return this.get(userId, name);
  }

  /**
   * M11-T3: the fix the fallback proposed for the latest version, approved: checked like an import and saved as the
   * next version (runs use it from now on); the proposal is cleared.
   */
  async approveFix(userId: string, name: string): Promise<RecipeDetailView> {
    const latest = await this.latestWithFix(userId, name);
    const recipe = RecipeSchema.safeParse(latest.proposed);
    const problems = recipe.success ? recipeProblems(name, recipe.data) : recipe.error.issues.map((i) => `${i.path.join(".") || "recipe"}: ${i.message}`);
    if (!recipe.success || problems.length > 0) throw new BadRequestException(`The proposed fix is not a valid recipe: ${problems.join("; ")}`);
    await this.prisma.client.$transaction([
      this.prisma.client.siteRecipe.create({
        data: { userId, name, site: siteOf(name), version: latest.version + 1, steps: recipe.data, lastVerifiedAt: latest.proposedAt, taughtInRunId: latest.proposedInRunId },
      }),
      this.prisma.client.siteRecipe.update({ where: { siteRecipeId: latest.siteRecipeId }, data: { proposed: Prisma.DbNull, proposedAt: null, proposedInRunId: null } }),
    ]);
    return this.get(userId, name);
  }

  /** M11-T3: the proposed fix, discarded; the next breakage may propose another. */
  async discardFix(userId: string, name: string): Promise<RecipeDetailView> {
    const latest = await this.latestWithFix(userId, name);
    await this.prisma.client.siteRecipe.update({ where: { siteRecipeId: latest.siteRecipeId }, data: { proposed: Prisma.DbNull, proposedAt: null, proposedInRunId: null } });
    return this.get(userId, name);
  }

  private async latestWithFix(userId: string, name: string): Promise<SiteRecipe> {
    const latest = await this.prisma.client.siteRecipe.findFirst({ where: { userId, name }, orderBy: { version: "desc" } });
    if (!latest) throw new NotFoundException();
    if (latest.proposed === null) throw new BadRequestException(`${name} v${latest.version} has no proposed fix`);
    return latest;
  }

  /** Starts teach mode: the "Teach <name>" pipeline, created or given these inputs as its next version, then run. */
  async teach(userId: string, body: TeachRecipeRequest): Promise<TeachStartedView> {
    const name = checkedName(body.name);
    const pipelineName = `Teach ${name}`;
    // JSON is YAML: the compiler checks it like any pipeline (the url on the recipe's site is checked by the step).
    const source = JSON.stringify({
      name: pipelineName,
      description: `Teach mode for the recipe ${name}: you show the list in the live browser, then check what it reads.`,
      steps: [
        {
          id: "teach",
          type: "browser.teach",
          with: { recipe: name, url: body.url, params: body.params, ...(body.fields ? { fields: body.fields } : {}), ...(body.hint ? { hint: body.hint } : {}) },
        },
      ],
    });
    const existing = await this.prisma.client.pipeline.findFirst({ where: { userId, name: pipelineName }, orderBy: { dateCreated: "asc" } });
    let pipelineId: string;
    if (existing) {
      pipelineId = existing.pipelineId;
      await this.pipelines.addVersion(userId, pipelineId, source).catch((error: unknown) => {
        // The same inputs as last time: run the current version again.
        if (!(error instanceof UnprocessableEntityException)) throw error;
      });
    } else {
      pipelineId = (await this.pipelines.create(userId, source)).pipelineId;
    }
    const run = await this.runs.start(userId, pipelineId, false);
    return { runId: run.runId, pipelineId };
  }
}

function checkedName(name: string): string {
  if (!RECIPE_NAME.test(name)) throw new BadRequestException('A recipe name is "<site>/<what>", e.g. "jobs.example.com/search"');
  return name;
}

function jobView(posting: JobPosting & { applications: Application[] }): JobPostingView {
  const application = posting.applications[0];
  return {
    jobPostingId: posting.jobPostingId,
    url: posting.url,
    title: posting.title,
    company: posting.company,
    location: posting.location,
    source: posting.source,
    score: posting.score,
    scoreReason: posting.scoreReason,
    status: posting.status,
    firstSeenAt: posting.firstSeenAt.toISOString(),
    lastSeenAt: posting.lastSeenAt.toISOString(),
    application: application ? applicationView(application) : null,
  };
}

function versionView(row: SiteRecipe): RecipeVersionView {
  return {
    version: row.version,
    recipe: row.steps,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    lastItemsAt: row.lastItemsAt?.toISOString() ?? null,
    quiet: row.quietToldAt !== null,
    brokenAt: row.brokenAt?.toISOString() ?? null,
    brokenReason: row.brokenReason,
    taughtInRunId: row.taughtInRunId,
    proposed: row.proposed,
    proposedAt: row.proposedAt?.toISOString() ?? null,
    proposedInRunId: row.proposedInRunId,
    dateCreated: row.dateCreated.toISOString(),
  };
}

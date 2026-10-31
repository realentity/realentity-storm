import { type JobPosting, type Prisma, type SiteRecipe } from "@ai-me/db";
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
} from "@ai-me/shared";
import { RECIPE_NAME, recipeProblems, RecipeSchema, siteOf } from "@ai-me/steps";
import { BadRequestException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { parse as parseYaml } from "yaml";
import { PrismaService } from "../database/prisma.service";
import { PipelinesService } from "../pipelines/pipelines.service";
import { RunsService } from "../runs/runs.service";

/** The Jobs page (README §11 Phase 2, M9-T6): postings saved by data.save, scored, and what I decided about them. */
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
    });
    return postings.map(jobView);
  }

  async update(userId: string, jobPostingId: string, body: UpdateJobRequest): Promise<JobPostingView> {
    const updated = await this.prisma.client.jobPosting.updateMany({ where: { jobPostingId, userId }, data: { status: body.status } });
    if (updated.count === 0) throw new NotFoundException();
    return jobView(await this.prisma.client.jobPosting.findUniqueOrThrow({ where: { jobPostingId } }));
  }
}

/**
 * Site recipes (README §2.4): listed with their health, imported as a new version (checked like a taught one), or
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
      brokenAt: row.brokenAt?.toISOString() ?? null,
      brokenReason: row.brokenReason,
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

  /** Starts teach mode: the "Teach <name>" pipeline, created or given these inputs as its next version, then run. */
  async teach(userId: string, body: TeachRecipeRequest): Promise<TeachStartedView> {
    const name = checkedName(body.name);
    const pipelineName = `Teach ${name}`;
    // JSON is YAML: the compiler checks it like any pipeline (the url on the recipe's site is checked by the step).
    const source = JSON.stringify({
      name: pipelineName,
      description: `Teach mode for the recipe ${name}: I show the list in the live browser, then check what it reads.`,
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
  if (!RECIPE_NAME.test(name)) throw new BadRequestException('A recipe name is "<site>/<what>", e.g. "dev.bg/search"');
  return name;
}

function jobView(posting: JobPosting): JobPostingView {
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
  };
}

function versionView(row: SiteRecipe): RecipeVersionView {
  return {
    version: row.version,
    recipe: row.steps,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    brokenAt: row.brokenAt?.toISOString() ?? null,
    brokenReason: row.brokenReason,
    taughtInRunId: row.taughtInRunId,
    dateCreated: row.dateCreated.toISOString(),
  };
}

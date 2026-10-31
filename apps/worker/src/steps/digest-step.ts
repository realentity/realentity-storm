import { type PrismaClient } from "@ai-me/db";
import { type StepContext, type StepExecutor } from "../runner/step-executor";
import { llmSpendSince } from "../runner/llm-spend";
import { RunControls } from "../runner/run-controls";

const STATUS_WORDS: Record<string, string> = {
  DONE: "done",
  FAILED: "failed",
  WAITING_FOR_USER: "waiting for me",
  ABORTED: "stopped",
  RUNNING: "running",
  QUEUED: "queued",
};
const MAX_FAILURES = 10;
/** Of a list waiting for me to pick from (gate.review): the best few, by score. */
const TOP_TO_PICK = 3;

/** What notify.digest needs from notify.telegram: sending one text. */
export interface TextSender {
  execute(input: { text: string }, context: StepContext): Promise<unknown>;
}

/**
 * notify.digest (README §12): what ran in the last `hours`, what waits for me, what failed, what reflection suggests
 * and what the LLM cost, as one Telegram message. Run summaries and step errors only: no payloads or email text.
 */
export class DigestStep implements StepExecutor {
  readonly type = "notify.digest";

  constructor(
    private readonly prisma: PrismaClient,
    private readonly telegram: TextSender,
  ) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const text = await this.compose(context.userId, Number(input.hours), context.runId);
    await this.telegram.execute({ text }, context);
    return { sent: true, text };
  }

  async compose(userId: string, hours: number, ownRunId: string, now = new Date()): Promise<string> {
    const since = new Date(now.getTime() - hours * 60 * 60 * 1000);
    const runs = await this.prisma.run.findMany({
      where: { userId, startedAt: { gte: since }, runId: { not: ownRunId } },
      include: {
        pipelineVersion: { select: { pipeline: { select: { name: true } } } },
        steps: { where: { status: "FAILED" }, select: { stepKey: true, error: true }, take: 1 },
      },
      orderBy: { startedAt: "asc" },
    });
    const waiting = await this.prisma.proposal.findMany({
      where: { userId, status: "PENDING_REVIEW" },
      select: {
        originalPayload: true,
        step: { select: { type: true } },
        run: { select: { pipelineVersion: { select: { pipeline: { select: { name: true } } } } } },
      },
      orderBy: { dateCreated: "asc" },
    });

    const lines = [`AI ME · last ${hours} h`];
    const counts = new Map<string, number>();
    for (const run of runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1);
    lines.push(
      runs.length === 0
        ? "Runs: none"
        : `Runs: ${runs.length} (${[...counts].map(([status, n]) => `${n} ${STATUS_WORDS[status] ?? status.toLowerCase()}`).join(", ")})`,
    );

    if (waiting.length > 0) {
      const byPipeline = new Map<string, number>();
      for (const p of waiting)
        byPipeline.set(p.run.pipelineVersion.pipeline.name, (byPipeline.get(p.run.pipelineVersion.pipeline.name) ?? 0) + 1);
      lines.push(`Waiting for me: ${waiting.length} (${[...byPipeline].map(([name, n]) => `${name}: ${n}`).join(", ")})`);
      for (const review of waiting.filter((p) => p.step.type === "gate.review")) {
        const items = ((review.originalPayload as { items?: unknown[] }).items ?? []).filter(isRecord);
        const best = [...items].sort((a, b) => scoreOf(b) - scoreOf(a)).slice(0, TOP_TO_PICK);
        lines.push(
          `• To pick in ${review.run.pipelineVersion.pipeline.name}: ${items.length}${best.length ? `, best: ${best.map(label).join("; ")}` : ""}`,
        );
      }
    } else {
      lines.push("Waiting for me: nothing");
    }

    const failed = runs.filter((r) => r.status === "FAILED");
    if (failed.length > 0) {
      lines.push("Failed:");
      for (const run of failed.slice(0, MAX_FAILURES)) {
        const step = run.steps[0];
        const why = run.summary ?? (step ? `${step.stepKey}: ${step.error ?? "failed"}` : "failed");
        lines.push(`• ${run.pipelineVersion.pipeline.name}: ${why.slice(0, 200)}`);
      }
      if (failed.length > MAX_FAILURES) lines.push(`• … and ${failed.length - MAX_FAILURES} more`);
    }

    const [rules, suggestions] = await Promise.all([
      this.prisma.rule.count({ where: { userId, status: "SUGGESTED" } }),
      this.prisma.pipelineSuggestion.count({ where: { userId, status: "OPEN" } }),
    ]);
    if (rules + suggestions > 0) {
      lines.push(`Suggested by reflection: ${rules} rule(s), ${suggestions} pipeline change(s) (Rules page)`);
    }

    const broken = await this.brokenRecipes(userId);
    if (broken.length > 0) lines.push(`Broken recipes: ${broken.join(", ")} (Recipes page)`);

    const [window, month] = await Promise.all([
      llmSpendSince(this.prisma, userId, since),
      new RunControls(this.prisma).monthlySpendUsd(userId, now),
    ]);
    lines.push(`LLM: $${window.toFixed(4)} (this month $${month.toFixed(2)})`);
    return lines.join("\n");
  }

  /** Recipes whose latest version no longer matches its page (M9-T7). */
  private async brokenRecipes(userId: string): Promise<string[]> {
    const rows = await this.prisma.siteRecipe.findMany({
      where: { userId },
      select: { name: true, version: true, brokenAt: true },
      orderBy: { version: "desc" },
    });
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) if (!latest.has(row.name)) latest.set(row.name, row);
    return [...latest.values()].filter((row) => row.brokenAt).map((row) => `${row.name} v${row.version}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scoreOf(item: Record<string, unknown>): number {
  return typeof item.score === "number" ? item.score : -1;
}

/** "Senior .NET Developer · Acme (91)": a job's title, company and score; other items by their title or subject. */
function label(item: Record<string, unknown>): string {
  const text = (key: string) => (typeof item[key] === "string" ? item[key].slice(0, 80) : "");
  const name = text("title") || text("subject") || text("name") || "an item";
  const company = text("company");
  return `${name}${company ? ` · ${company}` : ""}${typeof item.score === "number" ? ` (${item.score})` : ""}`;
}

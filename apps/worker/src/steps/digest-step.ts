import { type PrismaClient } from "@ai-me/db";
import { type StepContext, type StepExecutor } from "../runner/step-executor";
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

/** What notify.digest needs from notify.telegram: sending one text. */
export interface TextSender {
  execute(input: { text: string }, context: StepContext): Promise<unknown>;
}

/**
 * notify.digest (README §12): what ran in the last `hours`, what waits for me, what failed, and what the LLM cost,
 * as one Telegram message. Run summaries and step errors only: no payloads or email text.
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
      select: { run: { select: { pipelineVersion: { select: { pipeline: { select: { name: true } } } } } } },
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

    const [window, month] = await Promise.all([this.spentSince(userId, since), new RunControls(this.prisma).monthlySpendUsd(userId, now)]);
    lines.push(`LLM: $${window.toFixed(4)} (this month $${month.toFixed(2)})`);
    return lines.join("\n");
  }

  private async spentSince(userId: string, since: Date): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ spent: string | null }[]>`
      SELECT SUM((s."llmUsage"->>'costUsd')::numeric)::text AS spent
      FROM "Steps" s JOIN "Runs" r ON r."runId" = s."runId"
      WHERE r."userId" = ${userId}::uuid AND s."startedAt" >= ${since} AND s."llmUsage" ? 'costUsd'`;
    return Number(rows[0]?.spent ?? 0);
  }
}

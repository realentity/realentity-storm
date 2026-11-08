import { type PrismaClient, type Takeover } from "@realentity/storm-db";
import { type TelegramMessage } from "@realentity/storm-shared";
import { type EventSink } from "./pipeline-runner";
import { RunStopped, type Attention } from "./step-executor";

export interface TakeoverScope {
  runId: string;
  userId: string;
  pipelineId: string;
  stepKey: string;
  itemIndex: number | null;
}

export interface TakeoverOptions {
  timeoutMs: number;
  pollMs?: number;
  /** "Storm needs you" on Telegram, with a button to the run. */
  notify?: (message: TelegramMessage) => Promise<void>;
  /** The address the browser uses (APP_ORIGIN), for the link. */
  appOrigin?: string;
}

const WAITING = ["OPEN", "TAKEN_OVER"] as const;

/**
 * The live browser handed to me and back (README §6, M8-T4/T5). The step stays in progress with its page open; the
 * run shows WAITING_FOR_USER (no other job claims it while a takeover is open) until I press Continue, which goes on
 * from the page as I left it, or Abort, which stops the run. Nobody within the timeout fails the step; the kill switch
 * stops the run.
 */
export class TakeoverDesk {
  private readonly pollMs: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly events: EventSink,
    private readonly options: TakeoverOptions,
  ) {
    this.pollMs = options.pollMs ?? 1_000;
  }

  for(scope: TakeoverScope): Attention {
    return {
      checkpoint: async (url) => {
        const takeover = await this.prisma.takeover.findFirst({ where: { runId: scope.runId, status: "TAKEN_OVER" } });
        if (!takeover) return;
        if (url) await this.prisma.takeover.update({ where: { takeoverId: takeover.takeoverId }, data: { url } });
        await this.wait(scope, takeover);
      },
      needMe: async (reason, url, options = {}) => {
        const takeover = await this.prisma.takeover.create({
          data: {
            runId: scope.runId,
            stepKey: scope.stepKey,
            itemIndex: scope.itemIndex,
            status: "OPEN",
            reason,
            url: url ?? null,
            waitsFor: options.waitsFor ?? null,
          },
        });
        await this.emit(scope, "OPEN");
        const origin = this.options.appOrigin;
        const button = options.button ?? (origin ? { text: "Open the live view", url: `${origin}/runs/${scope.runId}` } : null);
        if (options.notify !== false)
          await this.options
            .notify?.({
              text: `Storm needs you: ${reason} at ${scope.stepKey}${url && !options.waitsFor ? ` (${hostOf(url)})` : ""}.`,
              buttons: button ? [[button]] : [],
            })
            .catch(() => undefined);
        await this.wait(scope, takeover);
      },
    };
  }

  /**
   * After a restart the pages are gone: open takeovers expire, and their runs go back to RUNNING so the runner's
   * recovery treats the step as interrupted (a browser step simply runs again).
   */
  async recover(): Promise<void> {
    const open = await this.prisma.takeover.findMany({ where: { status: { in: [...WAITING] } } });
    for (const takeover of open) {
      await this.prisma.takeover.update({
        where: { takeoverId: takeover.takeoverId },
        data: { status: "EXPIRED", resolvedAt: new Date() },
      });
      await this.prisma.run.updateMany({ where: { runId: takeover.runId, status: "WAITING_FOR_USER" }, data: { status: "RUNNING" } });
    }
  }

  private async wait(scope: TakeoverScope, takeover: Takeover): Promise<void> {
    await this.setRun(scope, "RUNNING", "WAITING_FOR_USER");
    const deadline = takeover.requestedAt.getTime() + this.options.timeoutMs;
    for (;;) {
      const [current, run] = await Promise.all([
        this.prisma.takeover.findUniqueOrThrow({ where: { takeoverId: takeover.takeoverId } }),
        this.prisma.run.findUniqueOrThrow({ where: { runId: scope.runId }, select: { status: true } }),
      ]);
      if (run.status === "ABORTED") {
        await this.resolve(scope, takeover, "EXPIRED");
        throw new RunStopped("Stopped while waiting for me in the live view");
      }
      if (current.status === "CONTINUED") {
        await this.setRun(scope, "WAITING_FOR_USER", "RUNNING");
        return;
      }
      if (current.status === "ABORTED") {
        await this.setRun(scope, "WAITING_FOR_USER", "RUNNING");
        throw new RunStopped("Aborted in the live view");
      }
      if (current.status === "EXPIRED" || Date.now() >= deadline) {
        await this.resolve(scope, takeover, "EXPIRED");
        await this.setRun(scope, "WAITING_FOR_USER", "RUNNING");
        throw new Error(`${takeover.reason}: nobody took over within ${duration(this.options.timeoutMs)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  private async resolve(scope: TakeoverScope, takeover: Takeover, status: "EXPIRED"): Promise<void> {
    const updated = await this.prisma.takeover.updateMany({
      where: { takeoverId: takeover.takeoverId, status: { in: [...WAITING] } },
      data: { status, resolvedAt: new Date() },
    });
    if (updated.count > 0) await this.emit(scope, status);
  }

  private async setRun(scope: TakeoverScope, from: "RUNNING" | "WAITING_FOR_USER", to: "RUNNING" | "WAITING_FOR_USER"): Promise<void> {
    const updated = await this.prisma.run.updateMany({ where: { runId: scope.runId, status: from }, data: { status: to } });
    if (updated.count > 0) {
      await this.events(scope.userId, { type: "run", runId: scope.runId, pipelineId: scope.pipelineId, status: to }).catch(() => undefined);
    }
  }

  private async emit(scope: TakeoverScope, status: Takeover["status"]): Promise<void> {
    await this.events(scope.userId, { type: "takeover", runId: scope.runId, status }).catch(() => undefined);
  }
}

function duration(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)} seconds` : `${Math.round(ms / 60_000)} minutes`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

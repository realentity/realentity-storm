import { sendTelegram, type ServerEnv } from "@realentity/storm-shared";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { SERVER_ENV } from "../config/server-env";
import { PrismaService } from "../database/prisma.service";

export type WorkerState = "up" | "down" | "unknown";

/** The worker beats every 30 s; this long without one means it is down (or hung). */
export const STALE_MS = 3 * 60_000;
const CHECK_MS = 60_000;

/**
 * Watches the worker's heartbeat (docs/design.md §13, M5-T6) and tells the user on Telegram when it goes down and when
 * it is back, once per change. Right after the api starts, a missing heartbeat is "unknown" for a grace period.
 */
@Injectable()
export class WorkerWatchdog implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger("WorkerWatchdog");
  private readonly startedAt = Date.now();
  private state: WorkerState = "unknown";
  private timer: NodeJS.Timeout | null = null;
  /** Replaceable in tests. */
  alert: (text: string) => Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SERVER_ENV) env: ServerEnv,
  ) {
    this.alert = (text) => sendTelegram({ botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }, text);
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.check().catch((error: Error) => this.logger.warn(error.message)), CHECK_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** The worker's state now, alerting on a change. */
  async check(now = new Date()): Promise<WorkerState> {
    const heartbeat = await this.prisma.client.serviceHeartbeat.findUnique({ where: { service: "worker" } });
    const fresh = heartbeat !== null && now.getTime() - heartbeat.lastSeenAt.getTime() < STALE_MS;
    const graceOver = now.getTime() - this.startedAt >= STALE_MS;
    const next: WorkerState = fresh ? "up" : graceOver ? "down" : "unknown";

    const previous = this.state;
    this.state = next;
    if (next === "down" && previous !== "down") {
      const since = heartbeat ? `last seen ${heartbeat.lastSeenAt.toISOString().replace("T", " ").slice(0, 16)} UTC` : "it hasn't started";
      await this.notify(`⚠️ Storm: the worker is down (${since}). Scheduled runs and approvals wait until it is back.`);
    } else if (next === "up" && previous === "down") {
      await this.notify("✅ Storm: the worker is back.");
    }
    return next;
  }

  get current(): WorkerState {
    return this.state;
  }

  private async notify(text: string): Promise<void> {
    await this.alert(text).catch((error: Error) => this.logger.warn(`Alert not sent: ${error.message}`));
  }
}

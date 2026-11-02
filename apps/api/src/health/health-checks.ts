import { type HealthCheck } from "@ai-me/db";
import { sendTelegram, type HealthCheckView, type HealthReport, type HealthView, type ServerEnv } from "@ai-me/shared";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { SERVER_ENV } from "../config/server-env";
import { PrismaService } from "../database/prisma.service";
import { WorkerWatchdog } from "./worker-watchdog";

const HOUR_MS = 60 * 60 * 1000;
const CHECK_MS = 10 * 60_000;

/**
 * the server's own jobs, watched (M26, README §13): each reports its result (POST /hooks/health); a failed report, or a
 * job that stops reporting, is told on Telegram once, and once again when it is fine. The worker has its watchdog.
 */
@Injectable()
export class HealthChecks implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(HealthChecks.name);
  private timer: NodeJS.Timeout | null = null;
  /** Replaceable in tests. */
  alert: (text: string) => Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly watchdog: WorkerWatchdog,
    @Inject(SERVER_ENV) env: ServerEnv,
  ) {
    this.alert = (text) => sendTelegram({ botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }, text);
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.evaluate().catch((error: Error) => this.logger.warn(error.message)), CHECK_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async report(report: Required<HealthReport>, now = new Date()): Promise<void> {
    const data = { ok: report.ok, detail: report.detail, reportedAt: now, maxAgeHours: report.maxAgeHours };
    await this.prisma.client.healthCheck.upsert({ where: { name: report.name }, create: { name: report.name, ...data }, update: data });
    await this.evaluate(now);
  }

  /** Tells each check whose state changed since it was last told. */
  async evaluate(now = new Date()): Promise<void> {
    for (const check of await this.prisma.client.healthCheck.findMany({ orderBy: { name: "asc" } })) {
      const view = viewOf(check, now);
      if (view.problem === check.toldProblem) continue;
      // Claimed first, so two evaluations at once tell it once.
      const claimed = await this.prisma.client.healthCheck.updateMany({
        where: { name: check.name, toldProblem: check.toldProblem },
        data: { toldProblem: view.problem, toldAt: now },
      });
      if (claimed.count === 0) continue;
      const text = view.problem
        ? `⚠️ AI ME: ${check.name}: ${view.stale ? `no report since ${utc(check.reportedAt)} (expected every ${check.maxAgeHours} h)` : check.detail || "failed"}`
        : `✅ AI ME: ${check.name} is fine again${check.detail ? `: ${check.detail}` : ""}`;
      await this.alert(text).catch((error: Error) => this.logger.warn(`Alert not sent: ${error.message}`));
    }
  }

  async view(now = new Date()): Promise<HealthView> {
    const [checks, heartbeat] = await Promise.all([
      this.prisma.client.healthCheck.findMany({ orderBy: { name: "asc" } }),
      this.prisma.client.serviceHeartbeat.findUnique({ where: { service: "worker" } }),
    ]);
    return {
      worker: { state: this.watchdog.current, lastSeenAt: heartbeat?.lastSeenAt.toISOString() ?? null },
      checks: checks.map((check) => viewOf(check, now)),
    };
  }
}

function viewOf(check: HealthCheck, now: Date): HealthCheckView {
  const stale = now.getTime() - check.reportedAt.getTime() > check.maxAgeHours * HOUR_MS;
  return {
    name: check.name,
    ok: check.ok,
    detail: check.detail,
    reportedAt: check.reportedAt.toISOString(),
    maxAgeHours: check.maxAgeHours,
    stale,
    problem: stale || !check.ok,
  };
}

function utc(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

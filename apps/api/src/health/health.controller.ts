import { type HealthView } from "@ai-me/shared";
import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { Public } from "../auth/public.decorator";
import { PrismaService } from "../database/prisma.service";
import { HealthChecks } from "./health-checks";
import { WorkerWatchdog, type WorkerState } from "./worker-watchdog";

@Controller("health")
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly watchdog: WorkerWatchdog,
    private readonly checks: HealthChecks,
  ) {}

  /** The Health page (M26): the worker and what the server's jobs reported. */
  @Get("checks")
  checksView(): Promise<HealthView> {
    return this.checks.view();
  }

  @Public()
  @SkipThrottle()
  @Get()
  /** The api and its database (the container health check); the worker's state as last checked, for information. */
  async check(): Promise<{ status: "ok"; worker: WorkerState }> {
    try {
      await this.prisma.client.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException("database unreachable");
    }
    return { status: "ok", worker: this.watchdog.current };
  }
}

import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { Public } from "../auth/public.decorator";
import { PrismaService } from "../database/prisma.service";
import { WorkerWatchdog, type WorkerState } from "./worker-watchdog";

@Controller("health")
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly watchdog: WorkerWatchdog,
  ) {}

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

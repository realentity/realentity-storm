import { type PrismaClient } from "@ai-me/db";
import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaService } from "../database/prisma.service";

export const HEARTBEAT_SERVICE = "worker";
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** Touched with every beat; the container health check reads its age. */
export const HEARTBEAT_FILE = join(tmpdir(), "aime-worker.alive");

/** Records that the worker is alive (ServiceHeartbeat); the api alerts me on Telegram when it goes stale. */
export async function beat(prisma: PrismaClient, startedAt: Date, now = new Date()): Promise<void> {
  await prisma.serviceHeartbeat.upsert({
    where: { service: HEARTBEAT_SERVICE },
    create: { service: HEARTBEAT_SERVICE, startedAt, lastSeenAt: now },
    update: { startedAt, lastSeenAt: now },
  });
  await writeFile(HEARTBEAT_FILE, now.toISOString());
}

@Injectable()
export class Heartbeat implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger("Heartbeat");
  private readonly startedAt = new Date();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly db: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.tick();
    this.timer = setInterval(() => void this.tick(), HEARTBEAT_INTERVAL_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    await beat(this.db.client, this.startedAt).catch((error: Error) => this.logger.warn(`Heartbeat not recorded: ${error.message}`));
  }
}

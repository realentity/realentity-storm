import { type ServerEnv, type LiveView, type TakeoverView } from "@ai-me/shared";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createReadStream, type ReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { SERVER_ENV } from "../config/server-env";
import { PrismaService } from "../database/prisma.service";
import { EventsService } from "../events/events.service";
import { takeoverView } from "../runs/runs.service";

/** Where noVNC connects: Caddy sends it to the worker's websockify after checking my session. */
export const LIVE_PATH = "/vnc/";

const WAITING = ["OPEN", "TAKEN_OVER"] as const;

export interface TakeoverListItem extends TakeoverView {
  runId: string;
  pipelineName: string;
}

/**
 * The live view and takeover (README §6). The worker's step waits with the page open; these only change the
 * Takeover row it watches. The full VNC password goes out only while a takeover is open: until then the live view
 * connects with the view-only one, and x11vnc ignores input on it.
 */
@Injectable()
export class LiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
  ) {}

  async live(userId: string, runId: string): Promise<LiveView> {
    const run = await this.findRun(userId, runId);
    const available = Boolean(this.env.VNC_PASSWORD && this.env.VNC_VIEW_PASSWORD);
    const active = run.headed && (run.status === "RUNNING" || run.status === "WAITING_FOR_USER");
    const open = active ? await this.openTakeover(runId) : null;
    const control = open !== null;
    return {
      available,
      active,
      path: LIVE_PATH,
      password: available && active ? ((control ? this.env.VNC_PASSWORD : this.env.VNC_VIEW_PASSWORD) ?? null) : null,
      control,
    };
  }

  /** Take over at any time while a headed run runs: its step pauses at its next safe point. */
  async takeOver(userId: string, runId: string): Promise<void> {
    const run = await this.findRun(userId, runId);
    if (!run.headed || (run.status !== "RUNNING" && run.status !== "WAITING_FOR_USER")) {
      throw new ConflictException("Only a headed run in progress can be taken over");
    }
    if (await this.openTakeover(runId)) return;
    await this.prisma.client.takeover.create({ data: { runId, status: "TAKEN_OVER", reason: "Taken over" } });
    await this.events.publish(userId, { type: "takeover", runId, status: "TAKEN_OVER" });
  }

  /** Continue from the page as I left it, or Abort the run. */
  async resolve(userId: string, runId: string, status: "CONTINUED" | "ABORTED"): Promise<void> {
    await this.findRun(userId, runId);
    const updated = await this.prisma.client.takeover.updateMany({
      where: { runId, status: { in: [...WAITING] } },
      data: { status, resolvedAt: new Date() },
    });
    if (updated.count === 0) throw new ConflictException("The run isn't waiting for me");
    await this.events.publish(userId, { type: "takeover", runId, status });
  }

  /** Runs waiting for me in the live view (the inbox lists them first). */
  async waiting(userId: string): Promise<TakeoverListItem[]> {
    const takeovers = await this.prisma.client.takeover.findMany({
      where: { status: { in: [...WAITING] }, run: { userId } },
      include: { run: { include: { pipelineVersion: { include: { pipeline: { select: { name: true } } } } } } },
      orderBy: { requestedAt: "asc" },
    });
    return takeovers.map((t) => ({
      ...takeoverView(t, this.env.TAKEOVER_TIMEOUT_MINUTES),
      runId: t.runId,
      pipelineName: t.run.pipelineVersion.pipeline.name,
    }));
  }

  /** A run's file (screenshot, trace, download), mine only, from inside ARTIFACTS_DIR only. */
  async artifact(userId: string, artifactId: string): Promise<{ stream: ReadStream; mime: string; name: string; size: number }> {
    const artifact = await this.prisma.client.artifact.findFirst({ where: { artifactId, userId } });
    if (!artifact) throw new NotFoundException();
    const root = resolve(this.env.ARTIFACTS_DIR);
    const path = resolve(root, artifact.path);
    const inside = relative(root, path);
    if (inside.startsWith("..") || isAbsolute(inside)) throw new NotFoundException();
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new NotFoundException("The file is gone");
    return {
      stream: createReadStream(path),
      mime: artifact.mime ?? "application/octet-stream",
      name: artifact.path.split("/").pop() ?? "artifact",
      size: info.size,
    };
  }

  private async findRun(userId: string, runId: string) {
    const run = await this.prisma.client.run.findFirst({ where: { runId, userId } });
    if (!run) throw new NotFoundException();
    return run;
  }

  private openTakeover(runId: string) {
    return this.prisma.client.takeover.findFirst({ where: { runId, status: { in: [...WAITING] } } });
  }
}

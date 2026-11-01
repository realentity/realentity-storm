import { type ScheduledStart } from "@ai-me/db";
import { type ScheduledStartView } from "@ai-me/shared";
import { Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { CurrentUser, type AuthenticatedUser } from "../auth/public.decorator";
import { PrismaService } from "../database/prisma.service";

/** The most recent starts listed for a pipeline: the pending ones and the last few that started or were cancelled. */
const LISTED = 20;

/** Pipelines that flow.later starts later (M14-T3): what is scheduled, and cancelling one before its time. */
@Controller("scheduled-starts")
export class ScheduledStartsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser, @Query("pipelineId", new ParseUUIDPipe({ optional: true })) pipelineId?: string): Promise<ScheduledStartView[]> {
    const rows = await this.prisma.client.scheduledStart.findMany({
      where: { userId: user.userId, ...(pipelineId ? { pipelineId } : {}) },
      include: { pipeline: { select: { name: true } } },
      orderBy: [{ status: "asc" }, { fireAt: "desc" }],
      take: LISTED,
    });
    return rows.map(view);
  }

  @Delete(":id")
  @HttpCode(204)
  async cancel(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    const { count } = await this.prisma.client.scheduledStart.updateMany({
      where: { scheduledStartId: id, userId: user.userId, status: "PENDING" },
      data: { status: "CANCELLED", reason: "cancelled by me" },
    });
    if (count === 0) throw new NotFoundException("No pending start with that id");
  }
}

function view(row: ScheduledStart & { pipeline: { name: string } }): ScheduledStartView {
  return {
    scheduledStartId: row.scheduledStartId,
    pipelineId: row.pipelineId,
    pipeline: row.pipeline.name,
    key: row.key,
    fireAt: row.fireAt.toISOString(),
    status: row.status,
    reason: row.reason,
    data: row.data,
    scheduledByRunId: row.scheduledByRunId,
    runId: row.runId,
  };
}

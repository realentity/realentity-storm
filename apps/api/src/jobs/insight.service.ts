import { JobQueue } from "@ai-me/queue";
import { OUTCOME_DATE, type ApplicationView, type FunnelRow, type InsightView, type UpdateApplicationRequest } from "@ai-me/shared";
import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

const BANDS = [
  { key: "80–100", min: 80 },
  { key: "60–79", min: 60 },
  { key: "40–59", min: 40 },
  { key: "0–39", min: 0 },
] as const;
const DAY_MS = 86_400_000;

/**
 * The job search in numbers (M16-T1): the postings found in the last `days`, and what came of each, from JobPosting
 * and its Application (an outcome's date counts even after the status moved on). By source, and by score band: the
 * calibration view. Also an application's outcome set by hand (M16-T3), which tells the pipelines like an email does.
 */
@Injectable()
export class InsightService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: JobQueue,
  ) {}

  async insight(userId: string, days: number, now = new Date()): Promise<InsightView> {
    const from = new Date(now.getTime() - days * DAY_MS);
    const postings = await this.prisma.client.jobPosting.findMany({ where: { userId, firstSeenAt: { gte: from } }, include: { applications: true } });
    const totals = row("all");
    const sources = new Map<string, FunnelRow>();
    const bands = new Map<string, FunnelRow>([...BANDS.map((b) => [b.key, row(b.key)] as const), ["unscored", row("unscored")]]);
    const answerDays: number[] = [];

    for (const posting of postings) {
      const application = posting.applications[0];
      const source = sources.get(posting.source) ?? row(posting.source);
      sources.set(posting.source, source);
      const band = bands.get(posting.score === null ? "unscored" : BANDS.find((b) => posting.score! >= b.min)!.key)!;
      const answered = application ? [application.respondedAt, application.interviewAt, application.rejectedAt].filter((d): d is Date => d !== null) : [];
      for (const target of [totals, source, band]) {
        target.found++;
        if (posting.status === "SHORTLISTED" || posting.status === "APPLIED" || application) target.shortlisted++;
        if (application?.submittedAt) {
          target.applied++;
          if (answered.length) target.replied++;
          else target.waiting++;
          if (application.interviewAt) target.interview++;
          if (application.rejectedAt) target.rejected++;
        }
      }
      if (application?.submittedAt && answered.length) {
        const first = Math.min(...answered.map((d) => d.getTime()));
        answerDays.push((first - application.submittedAt.getTime()) / DAY_MS);
      }
    }
    return {
      days,
      from: from.toISOString(),
      totals,
      bySource: [...sources.values()].sort((a, b) => b.found - a.found),
      byScore: [...bands.values()],
      medianDaysToAnswer: median(answerDays),
    };
  }

  /** By hand: any status (a mistake undone too); the outcome's date set the first time; the pipelines told. */
  async updateApplication(userId: string, applicationId: string, request: UpdateApplicationRequest): Promise<ApplicationView> {
    const application = await this.prisma.client.application.findFirst({ where: { applicationId, userId }, include: { jobPosting: true } });
    if (!application) throw new NotFoundException();
    const date = request.status === "SUBMITTED" ? null : OUTCOME_DATE[request.status];
    const note = `${new Date().toISOString().slice(0, 10)} ${request.status.toLowerCase()} (by hand)${request.note ? `: ${request.note}` : ""}`;
    const updated = await this.prisma.client.application.update({
      where: { applicationId },
      data: {
        status: request.status,
        ...(date && !application[date] ? { [date]: new Date() } : {}),
        ...(request.status === "SUBMITTED" && !application.submittedAt ? { submittedAt: new Date() } : {}),
        notes: application.notes ? `${application.notes}\n${note}` : note,
      },
    });
    if (updated.status !== application.status) {
      const { title, company, location, url } = application.jobPosting;
      await this.queue.enqueueEvent({ userId, event: "application.status", data: { applicationId, status: updated.status, job: { title, company, location, url } }, source: { depth: 0 } });
    }
    return applicationView(updated);
  }
}

function row(key: string): FunnelRow {
  return { key, found: 0, shortlisted: 0, applied: 0, replied: 0, interview: 0, rejected: 0, waiting: 0 };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Math.round(value * 10) / 10;
}

export function applicationView(application: {
  applicationId: string;
  status: ApplicationView["status"];
  submittedAt: Date | null;
  respondedAt: Date | null;
  interviewAt: Date | null;
  rejectedAt: Date | null;
  notes: string | null;
  runId: string | null;
}): ApplicationView {
  return {
    applicationId: application.applicationId,
    status: application.status,
    submittedAt: application.submittedAt?.toISOString() ?? null,
    respondedAt: application.respondedAt?.toISOString() ?? null,
    interviewAt: application.interviewAt?.toISOString() ?? null,
    rejectedAt: application.rejectedAt?.toISOString() ?? null,
    notes: application.notes,
    runId: application.runId,
  };
}

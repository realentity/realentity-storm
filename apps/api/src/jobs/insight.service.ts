import { JobQueue } from "@ai-me/queue";
import { OUTCOME_DATE, readAppSource, type ApplicationView, type FunnelRow, type InsightView, type UpdateApplicationRequest } from "@ai-me/shared";
import { contractProblems, JOB_ENTITY } from "@ai-me/steps";
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
    const postings = await this.postings(userId, from);
    const totals = row("all");
    const sources = new Map<string, FunnelRow>();
    const bands = new Map<string, FunnelRow>([...BANDS.map((b) => [b.key, row(b.key)] as const), ["unscored", row("unscored")]]);
    const answerDays: number[] = [];

    for (const posting of postings) {
      const source = sources.get(posting.source) ?? row(posting.source);
      sources.set(posting.source, source);
      const band = bands.get(posting.score === null ? "unscored" : BANDS.find((b) => posting.score! >= b.min)!.key)!;
      const answered = [posting.respondedAt, posting.interviewAt, posting.rejectedAt].filter((d): d is Date => d !== null);
      for (const target of [totals, source, band]) {
        target.found++;
        if (posting.shortlisted) target.shortlisted++;
        if (posting.submittedAt) {
          target.applied++;
          if (answered.length) target.replied++;
          else target.waiting++;
          if (posting.interviewAt) target.interview++;
          if (posting.rejectedAt) target.rejected++;
        }
      }
      if (posting.submittedAt && answered.length) {
        const first = Math.min(...answered.map((d) => d.getTime()));
        answerDays.push((first - posting.submittedAt.getTime()) / DAY_MS);
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

  /**
   * The postings found since `from` and what came of each. M33: from the Jobs of my Apps when I have one (the dates
   * each reached its stages), else from what the old Jobs page kept.
   */
  private async postings(userId: string, from: Date): Promise<Posting[]> {
    const appIds = await this.jobApps(userId);
    if (appIds.length > 0) {
      const jobs = await this.prisma.client.dataEntity.findMany({ where: { appId: { in: appIds }, type: "Job", firstSeenAt: { gte: from } } });
      return jobs.map((job) => {
        const value = job.value as { score?: unknown; source?: unknown };
        const dates = job.stageDates as Record<string, string>;
        const at = (stage: string) => (dates[stage] ? new Date(dates[stage]) : null);
        return {
          source: typeof value.source === "string" && value.source ? value.source : hostOf(job.key),
          score: typeof value.score === "number" ? value.score : null,
          shortlisted: ["shortlisted", "prepared", "applied"].some((stage) => dates[stage]),
          submittedAt: at("applied"),
          respondedAt: at("responded"),
          interviewAt: at("interview"),
          rejectedAt: at("rejected"),
        };
      });
    }
    const postings = await this.prisma.client.jobPosting.findMany({ where: { userId, firstSeenAt: { gte: from } }, include: { applications: true } });
    return postings.map((posting) => {
      const application = posting.applications[0];
      return {
        source: posting.source,
        score: posting.score,
        shortlisted: posting.status === "SHORTLISTED" || posting.status === "APPLIED" || application !== undefined,
        submittedAt: application?.submittedAt ?? null,
        respondedAt: application?.respondedAt ?? null,
        interviewAt: application?.interviewAt ?? null,
        rejectedAt: application?.rejectedAt ?? null,
      };
    });
  }

  /** My Apps that keep jobs: a Job type the job steps can move. */
  private async jobApps(userId: string): Promise<string[]> {
    const apps = await this.prisma.client.app.findMany({ where: { userId, currentVersionId: { not: null } } });
    const versions = await this.prisma.client.appVersion.findMany({ where: { appVersionId: { in: apps.map((a) => a.currentVersionId!) } } });
    return apps.flatMap((app) => {
      const version = versions.find((v) => v.appVersionId === app.currentVersionId);
      const type = version ? readAppSource(version.source).types[JOB_ENTITY.type] : undefined;
      return type && contractProblems(type, JOB_ENTITY).length === 0 ? [app.appId] : [];
    });
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

interface Posting {
  source: string;
  score: number | null;
  shortlisted: boolean;
  submittedAt: Date | null;
  respondedAt: Date | null;
  interviewAt: Date | null;
  rejectedAt: Date | null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
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

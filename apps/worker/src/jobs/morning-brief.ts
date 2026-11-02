import { type PrismaClient } from "@ai-me/db";
import { type TelegramMessage } from "@ai-me/shared";
import { Logger } from "@nestjs/common";

const DAY_MS = 24 * 60 * 60 * 1000;
const ZONE = "Europe/Sofia";
/** Unpaid bills due this soon are in the brief (overdue ones too). */
const BILLS_DAYS = 3;
const MAX_FAILURES = 5;

/** Today's events, as the brief shows them; throws when the calendar can't be read. */
export interface BriefEvent {
  title: string;
  start: Date;
  allDay: boolean;
  location: string | null;
}
export type TodaysEvents = (userId: string, from: Date, to: Date) => Promise<BriefEvent[] | null>;

/**
 * The morning brief (M25, README §12): every morning on the AI ME bot, what today needs. Today's calendar (when
 * Google is connected), what waits for me (drafts and follow-ups at their gates, runs paused in the live view), the
 * runs that failed in the last day, unpaid bills due soon. A day with none of it says so in one line.
 */
export class MorningBrief {
  private readonly logger = new Logger(MorningBrief.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly notify: (message: TelegramMessage) => Promise<void>,
    /** null: no calendar (Google not connected). */
    private readonly events: TodaysEvents = () => Promise.resolve(null),
    private readonly appOrigin?: string,
  ) {}

  async sendAll(now = new Date()): Promise<number> {
    const users = await this.prisma.user.findMany({
      where: { OR: [{ settings: null }, { settings: { morningBrief: true } }] },
      select: { userId: true },
    });
    for (const { userId } of users) {
      await this.notify({ text: await this.compose(userId, now), buttons: this.appOrigin ? [[{ text: "Open AI ME", url: this.appOrigin }]] : undefined });
    }
    if (users.length > 0) this.logger.log(`Morning brief sent to ${users.length} user(s)`);
    return users.length;
  }

  async compose(userId: string, now = new Date()): Promise<string> {
    const title = `AI ME · ${now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: ZONE })}`;
    const parts = [await this.calendar(userId, now), await this.waiting(userId), await this.failed(userId, now), await this.bills(userId, now)].filter(
      (part): part is string => part !== null,
    );
    return [title, ...(parts.length ? parts : ["Nothing on the calendar, nothing waiting, nothing failed, no bills due."])].join("\n");
  }

  private async calendar(userId: string, now: Date): Promise<string | null> {
    const [from, to] = dayOf(now);
    let events: BriefEvent[] | null;
    try {
      events = await this.events(userId, from, to);
    } catch (error) {
      return `Calendar: can't be read (${error instanceof Error ? error.message : String(error)})`;
    }
    if (!events?.length) return null;
    const lines = events.map((e) => `• ${e.allDay ? "all day" : time(e.start)} ${e.title}${e.location ? ` (${e.location})` : ""}`);
    return ["Today:", ...lines].join("\n");
  }

  private async waiting(userId: string): Promise<string | null> {
    const [proposals, paused] = await Promise.all([
      this.prisma.proposal.findMany({
        where: { userId, status: "PENDING_REVIEW", run: { dryRun: false } },
        select: { run: { select: { pipelineVersion: { select: { pipeline: { select: { name: true } } } } } } },
      }),
      this.prisma.takeover.count({ where: { status: "OPEN", run: { userId } } }),
    ]);
    if (proposals.length === 0 && paused === 0) return null;
    const byPipeline = new Map<string, number>();
    for (const p of proposals) {
      const name = p.run.pipelineVersion.pipeline.name;
      byPipeline.set(name, (byPipeline.get(name) ?? 0) + 1);
    }
    const parts = [
      ...(proposals.length ? [`${proposals.length} to approve (${[...byPipeline].map(([name, n]) => `${name}: ${n}`).join(", ")})`] : []),
      ...(paused ? [`${paused} run(s) need you in the live view`] : []),
    ];
    return `Waiting for you: ${parts.join("; ")}`;
  }

  private async failed(userId: string, now: Date): Promise<string | null> {
    const runs = await this.prisma.run.findMany({
      where: { userId, status: "FAILED", dryRun: false, startedAt: { gte: new Date(now.getTime() - DAY_MS) } },
      include: {
        pipelineVersion: { select: { pipeline: { select: { name: true } } } },
        steps: { where: { status: "FAILED" }, select: { stepKey: true, error: true }, take: 1 },
      },
      orderBy: { startedAt: "asc" },
    });
    if (runs.length === 0) return null;
    const lines = runs.slice(0, MAX_FAILURES).map((run) => {
      const step = run.steps[0];
      const why = run.summary ?? (step ? `${step.stepKey}: ${step.error ?? "failed"}` : "failed");
      return `• ${run.pipelineVersion.pipeline.name}: ${why.slice(0, 160)}`;
    });
    if (runs.length > MAX_FAILURES) lines.push(`• … and ${runs.length - MAX_FAILURES} more`);
    return ["Failed in the last day:", ...lines].join("\n");
  }

  private async bills(userId: string, now: Date): Promise<string | null> {
    const today = dayString(now);
    const until = dayString(new Date(now.getTime() + BILLS_DAYS * DAY_MS));
    const due = await this.prisma.bill.findMany({
      where: { userId, paidAt: null, dueDate: { not: null, lte: new Date(`${until}T00:00:00Z`) } },
      orderBy: { dueDate: "asc" },
    });
    if (due.length === 0) return null;
    const lines = due.map((bill) => {
      const date = bill.dueDate!.toISOString().slice(0, 10);
      const when = date < today ? `overdue since ${date}` : date === today ? "due today" : `due ${date}`;
      return `• ${bill.issuer}: ${Number(bill.amount).toFixed(2)} ${bill.currency}, ${when}`;
    });
    return ["Bills:", ...lines].join("\n");
  }
}

/** Today in Sofia, as instants: from its midnight to the next. */
function dayOf(now: Date): [Date, Date] {
  const day = dayString(now);
  const offset = offsetMinutes(new Date(`${day}T12:00:00Z`));
  const from = new Date(Date.parse(`${day}T00:00:00Z`) - offset * 60_000);
  return [from, new Date(from.getTime() + DAY_MS)];
}

/** The date in Sofia, YYYY-MM-DD. */
function dayString(at: Date): string {
  return at.toLocaleDateString("en-CA", { timeZone: ZONE });
}

function offsetMinutes(at: Date): number {
  const local = new Date(at.toLocaleString("en-US", { timeZone: ZONE }));
  const utc = new Date(at.toLocaleString("en-US", { timeZone: "UTC" }));
  return Math.round((local.getTime() - utc.getTime()) / 60_000);
}

function time(at: Date): string {
  return at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: ZONE });
}

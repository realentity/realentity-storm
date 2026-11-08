import { createHash } from "node:crypto";
import { type StepContext, type StepExecutor } from "../runner/step-executor";
import { GoogleNeedsMe, type GoogleConnection } from "../google/google-connection";
import { toInstant } from "./time";

type Item = Record<string, unknown>;

export interface CalendarDependencies {
  google: GoogleConnection;
  /** APP_ORIGIN: the Reconnect button's address. */
  appOrigin?: string;
}

interface GoogleEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  iCalUID?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string }[];
  organizer?: { email?: string };
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
}

const WEEK_MS = 7 * 86_400_000;
const MAX_DESCRIPTION = 2_000;
/** A reconnect is asked for once: if Google still refuses after it, the step fails. */
const RECONNECTS = 1;

/**
 * Runs `work` against Google; when the calendar isn't connected or Google refused the connection, the run waits for
 * me (Telegram: a Reconnect button) and goes on once I signed in again (the api continues the wait).
 */
async function withGoogle<T>(deps: CalendarDependencies, context: StepContext, work: () => Promise<T>): Promise<T> {
  for (let asked = 0; ; asked++) {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof GoogleNeedsMe) || asked >= RECONNECTS) throw error;
      const url = deps.appOrigin ? `${deps.appOrigin}/settings#google` : undefined;
      await context.attention.needMe(`${error.message}: reconnect it in Settings, and the run goes on`, url, {
        waitsFor: "google",
        ...(url ? { button: { text: "Reconnect Google Calendar", url } } : {}),
      });
    }
  }
}

/** calendar.find (M14-T1): my calendar's events in a range, optionally matching a query. */
export class CalendarFindStep implements StepExecutor {
  readonly type = "calendar.find";

  constructor(private readonly deps: CalendarDependencies) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const { from, to, durationMinutes, query, timeZone, maxResults } = input as {
      from?: string;
      to?: string;
      durationMinutes?: number;
      query?: string;
      timeZone: string;
      maxResults: number;
    };
    const start = from ? toInstant(from, timeZone) : new Date();
    const end = to ? toInstant(to, timeZone) : new Date(start.getTime() + (durationMinutes ? durationMinutes * 60_000 : WEEK_MS));
    const events = await withGoogle(this.deps, context, () => listEvents(this.deps.google, context.userId, start, end, query, maxResults));
    const items = events.map(eventItem);
    return { events: items, count: items.length, none: items.length === 0 };
  }
}

/**
 * calendar.create (M14-T1): an event in my calendar, behind its gate (a side effect; with attendees, Google emails
 * them from my account). The same title at the same start already there isn't created again. The event's id comes
 * from the run's step, so a step run again after a crash finds the event it created instead of a second one.
 */
export class CalendarCreateStep implements StepExecutor {
  readonly type = "calendar.create";

  constructor(private readonly deps: CalendarDependencies) {}

  async execute(input: Record<string, unknown>, context: StepContext): Promise<unknown> {
    const event = input as {
      title: string;
      start: string;
      end?: string;
      durationMinutes: number;
      timeZone: string;
      description?: string;
      location?: string;
      attendees?: string[];
      meet: boolean;
      sendInvites: boolean;
    };
    const startsAt = toInstant(event.start, event.timeZone);
    const endsAt = event.end ? toInstant(event.end, event.timeZone) : new Date(startsAt.getTime() + event.durationMinutes * 60_000);
    if (endsAt <= startsAt) throw new Error(`The event ends (${endsAt.toISOString()}) before it starts (${startsAt.toISOString()})`);
    const { google } = this.deps;
    const userId = context.userId;

    return withGoogle(this.deps, context, async () => {
      const around = await listEvents(google, userId, new Date(startsAt.getTime() - 60_000), new Date(startsAt.getTime() + 60_000), undefined, 50);
      const same = around.find((e) => sameTitle(e.summary, event.title) && startOf(e)?.getTime() === startsAt.getTime());
      if (same) return { ...created(same, false), invited: [] };

      const id = eventId(context);
      const attendees = event.attendees ?? [];
      const body = {
        id,
        summary: event.title,
        ...(event.description ? { description: event.description } : {}),
        ...(event.location ? { location: event.location } : {}),
        // The exact instant, shown in the event's zone.
        start: { dateTime: startsAt.toISOString(), timeZone: event.timeZone },
        end: { dateTime: endsAt.toISOString(), timeZone: event.timeZone },
        ...(attendees.length ? { attendees: attendees.map((email) => ({ email })) } : {}),
        ...(event.meet ? { conferenceData: { createRequest: { requestId: id, conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}),
      };
      const query = { sendUpdates: attendees.length && event.sendInvites ? "all" : "none", ...(event.meet ? { conferenceDataVersion: "1" } : {}) };
      const inserted = await google.call<GoogleEvent>(userId, "POST", "/calendars/primary/events", query, body);
      // 409: this step created it before a crash or a retry.
      const saved = inserted.status === 409 ? (await google.call<GoogleEvent>(userId, "GET", `/calendars/primary/events/${id}`)).body : inserted.body;
      return { ...created(saved, true), invited: attendees.length && event.sendInvites ? attendees : [] };
    });
  }
}

export async function listEvents(google: GoogleConnection, userId: string, from: Date, to: Date, query: string | undefined, max: number): Promise<GoogleEvent[]> {
  const { body } = await google.call<{ items?: GoogleEvent[] }>(userId, "GET", "/calendars/primary/events", {
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(max),
    ...(query ? { q: query } : {}),
  });
  return (body.items ?? []).filter((e) => e.status !== "cancelled");
}

function eventItem(e: GoogleEvent): Item {
  return {
    id: e.id,
    title: e.summary ?? "(no title)",
    start: e.start?.dateTime ?? e.start?.date ?? null,
    end: e.end?.dateTime ?? e.end?.date ?? null,
    allDay: Boolean(e.start?.date && !e.start.dateTime),
    location: e.location ?? null,
    description: e.description ? e.description.slice(0, MAX_DESCRIPTION) : null,
    link: e.htmlLink ?? null,
    meetLink: meetLinkOf(e),
    attendees: (e.attendees ?? []).map((a) => a.email).filter(Boolean),
    organizer: e.organizer?.email ?? null,
    iCalUID: e.iCalUID ?? null,
  };
}

function created(e: GoogleEvent, isNew: boolean) {
  return { created: isNew, eventId: e.id, link: e.htmlLink ?? "", meetLink: meetLinkOf(e) };
}

function meetLinkOf(e: GoogleEvent): string | null {
  return e.hangoutLink ?? e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri ?? null;
}

function startOf(e: GoogleEvent): Date | null {
  const value = e.start?.dateTime ?? e.start?.date;
  return value ? new Date(value) : null;
}

const sameTitle = (a: string | undefined, b: string): boolean => (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

/** Google event ids are base32hex (0-9, a-v), 5 to 1024 characters: hex of the run's step fits. */
function eventId(context: StepContext): string {
  return `storm${createHash("sha256").update(`${context.runId}:${context.stepKey}:${context.itemIndex ?? ""}`).digest("hex").slice(0, 40)}`;
}

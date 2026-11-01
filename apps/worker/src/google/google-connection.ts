import { type KeyRing, open } from "@ai-me/crypto";
import { type PrismaClient } from "@ai-me/db";
import { GOOGLE_CALENDAR_API, refreshGoogleToken } from "@ai-me/shared";

export interface GoogleOptions {
  clientId?: string;
  clientSecret?: string;
  /** Tests answer for Google (token endpoint and Calendar API). */
  fetch?: typeof fetch;
  /** The Calendar API's base address; tests point it at their server. */
  apiBase?: string;
}

/** The calendar can't be used until I sign in with Google again (or for the first time): the step waits for me. */
export class GoogleNeedsMe extends Error {}

/** A minute less than Google says, so a token never expires mid-call. */
const EARLY_MS = 60_000;

/**
 * My Google account for the calendar steps (M14-T1). The refresh token is opened only here, for a fresh access token
 * (kept in memory until shortly before it expires). Google refusing it (revoked, expired) marks the connection
 * NEEDS_RECONNECT, and a call that works marks it CONNECTED again: Settings shows the state as last seen, nothing
 * checks it in the background.
 */
export class GoogleConnection {
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();
  private readonly send: typeof fetch;
  readonly apiBase: string;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly keys: KeyRing,
    private readonly options: GoogleOptions = {},
  ) {
    this.send = options.fetch ?? fetch;
    this.apiBase = options.apiBase ?? GOOGLE_CALENDAR_API;
  }

  /** A Calendar API call as me; JSON in and out. A 401 gets one fresh token, then needs me. */
  async call<T>(userId: string, method: "GET" | "POST", path: string, query: Record<string, string> = {}, body?: unknown): Promise<{ status: number; body: T }> {
    for (let attempt = 1; ; attempt++) {
      const token = await this.accessToken(userId);
      const url = `${this.apiBase}${path}${Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : ""}`;
      const response = await this.send(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 401) {
        this.tokens.delete(userId);
        if (attempt === 1) continue;
        throw await this.broken(userId, "Google no longer accepts AI ME's access");
      }
      const json = (await response.json().catch(() => ({}))) as T & { error?: { message?: string; status?: string } };
      if (response.status === 403 && /insufficient|scope/i.test(json.error?.status ?? json.error?.message ?? "")) {
        throw await this.broken(userId, "AI ME's access doesn't include the calendar");
      }
      if (response.status >= 400 && response.status !== 409) {
        throw new Error(`Google Calendar answered ${response.status}${json.error?.message ? `: ${json.error.message}` : ""}`);
      }
      await this.worked(userId);
      return { status: response.status, body: json };
    }
  }

  private async accessToken(userId: string): Promise<string> {
    const cached = this.tokens.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    const { clientId, clientSecret } = this.options;
    if (!clientId || !clientSecret) throw new Error("Google Calendar isn't set up: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are empty (.env)");
    const row = await this.prisma.googleConnection.findUnique({ where: { userId } });
    if (!row) throw new GoogleNeedsMe("Google Calendar isn't connected");
    if (row.status === "NEEDS_RECONNECT") throw new GoogleNeedsMe(row.brokenReason ?? "Google Calendar needs reconnecting");
    const result = await refreshGoogleToken(this.send, { clientId, clientSecret }, open(this.keys, userId, row));
    if (!result.ok) {
      if (result.reconnect) throw await this.broken(userId, `${result.error}: it was revoked or has expired`);
      throw new Error(result.error);
    }
    this.tokens.set(userId, { token: result.accessToken, expiresAt: Date.now() + result.expiresIn * 1000 - EARLY_MS });
    return result.accessToken;
  }

  private async broken(userId: string, reason: string): Promise<GoogleNeedsMe> {
    this.tokens.delete(userId);
    await this.prisma.googleConnection.updateMany({
      where: { userId, status: "CONNECTED" },
      data: { status: "NEEDS_RECONNECT", brokenAt: new Date(), brokenReason: reason },
    });
    return new GoogleNeedsMe(reason);
  }

  private async worked(userId: string): Promise<void> {
    await this.prisma.googleConnection.updateMany({ where: { userId }, data: { lastWorkedAt: new Date() } });
  }
}

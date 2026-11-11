import { type KeyRing, open } from "@realentity/storm-crypto";
import { type PrismaClient } from "@realentity/storm-db";
import { CALENDAR_SCOPE, DRIVE_SCOPE, GOOGLE_CALENDAR_API, GOOGLE_DRIVE_API, refreshGoogleToken } from "@realentity/storm-shared";

export interface GoogleOptions {
  clientId?: string;
  clientSecret?: string;
  /** Tests answer for Google (token endpoint, Calendar and Drive APIs). */
  fetch?: typeof fetch;
  /** The Calendar API's base address; tests point it at their server. */
  apiBase?: string;
  /** The Drive API's base address; tests point it at their server. */
  driveBase?: string;
}

/** What a call is for: each needs its own access, which the user may have left unticked at the sign-in. */
export type GoogleService = "calendar" | "drive";

const SERVICES: Record<GoogleService, { scope: string; name: string }> = {
  calendar: { scope: CALENDAR_SCOPE, name: "Google Calendar" },
  drive: { scope: DRIVE_SCOPE, name: "Google Drive" },
};

/** Google can't be used until the user signs in with Google again (or for the first time): the step waits for them. */
export class GoogleNeedsMe extends Error {}

/** A minute less than Google says, so a token never expires mid-call. */
const EARLY_MS = 60_000;

/**
 * The user's Google account for the calendar steps (M14-T1) and topics' Drive folders (M43-T2). The refresh token is
 * opened only here, for a fresh access token (kept in memory until shortly before it expires). Google refusing it
 * (revoked, expired) marks the connection NEEDS_RECONNECT, and a call that works marks it CONNECTED again: Settings shows
 * the state as last seen, nothing checks it in the background. A service the user didn't allow (the calendar or Drive
 * unticked) needs them without breaking the connection for the other one.
 */
export class GoogleConnection {
  private readonly tokens = new Map<string, { token: string; scopes: string[]; expiresAt: number }>();
  private readonly send: typeof fetch;
  readonly apiBase: string;
  readonly driveBase: string;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly keys: KeyRing,
    private readonly options: GoogleOptions = {},
  ) {
    this.send = options.fetch ?? fetch;
    this.apiBase = options.apiBase ?? GOOGLE_CALENDAR_API;
    this.driveBase = options.driveBase ?? GOOGLE_DRIVE_API;
  }

  /** A Calendar API call as the user; JSON in and out. A 401 gets one fresh token, then needs the user. */
  async call<T>(
    userId: string,
    method: "GET" | "POST",
    path: string,
    query: Record<string, string> = {},
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const url = `${this.apiBase}${path}${Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : ""}`;
    const response = await this.request(userId, "calendar", url, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (response.status >= 400 && response.status !== 409) {
      throw new Error(`Google Calendar answered ${response.status}${json.error?.message ? `: ${json.error.message}` : ""}`);
    }
    return { status: response.status, body: json };
  }

  /**
   * A request as the user to a Google API (`url`, absolute), its response as it came, errors other than access
   * included: the caller reads the body (JSON, or a file's bytes). A 401 gets one fresh token, then needs the user; a
   * 403 for a missing scope needs the user too.
   */
  async request(userId: string, service: GoogleService, url: string, init: RequestInit = {}): Promise<Response> {
    const { scope, name } = SERVICES[service];
    for (let attempt = 1; ; attempt++) {
      const { token, scopes } = await this.accessToken(userId);
      // Connected before this service was asked for, or left unticked: only a reconnect adds it.
      if (!scopes.includes(scope))
        throw new GoogleNeedsMe(`Storm's Google access doesn't include ${name}: reconnect Google in Settings and allow it`);
      const response = await this.send(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status === 401) {
        this.tokens.delete(userId);
        if (attempt === 1) continue;
        throw await this.broken(userId, "Google no longer accepts Storm's access");
      }
      if (response.status === 403) {
        const text = await response.clone().text();
        if (/insufficient|ACCESS_TOKEN_SCOPE/i.test(text))
          throw new GoogleNeedsMe(`Storm's Google access doesn't include ${name}: reconnect Google in Settings and allow it`);
      }
      if (response.ok) await this.worked(userId);
      return response;
    }
  }

  private async accessToken(userId: string): Promise<{ token: string; scopes: string[] }> {
    const cached = this.tokens.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const { clientId, clientSecret } = this.options;
    if (!clientId || !clientSecret) throw new Error("Google isn't set up: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are empty (.env)");
    const row = await this.prisma.googleConnection.findUnique({ where: { userId } });
    if (!row) throw new GoogleNeedsMe("Google isn't connected: connect it in Settings");
    if (row.status === "NEEDS_RECONNECT") throw new GoogleNeedsMe(row.brokenReason ?? "Google needs reconnecting");
    const result = await refreshGoogleToken(this.send, { clientId, clientSecret }, open(this.keys, userId, row));
    if (!result.ok) {
      if (result.reconnect) throw await this.broken(userId, `${result.error}: it was revoked or has expired`);
      throw new Error(result.error);
    }
    // What the refresh grants (Google says it); the sign-in's scopes when it doesn't.
    const fresh = {
      token: result.accessToken,
      scopes: result.scopes.length ? result.scopes : row.scopes,
      expiresAt: Date.now() + result.expiresIn * 1000 - EARLY_MS,
    };
    this.tokens.set(userId, fresh);
    return fresh;
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

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

/**
 * M50-T8: whose Google: one of the user's Google accounts by id (a step's `account` slot, a Drive source's), else
 * their default one.
 */
export interface GoogleWho {
  userId: string;
  account?: string | null;
}

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whose Google a step uses: `account` is a google slot's name (filled on the pipeline or its App) or an account's id;
 * a slot not filled, or none given, is the default account.
 */
export function googleWho(
  context: { userId: string; googleAccounts?: Readonly<Record<string, string>> },
  account?: string | null,
): GoogleWho {
  if (!account) return { userId: context.userId };
  if (ACCOUNT_ID.test(account)) return { userId: context.userId, account };
  return { userId: context.userId, account: context.googleAccounts?.[account] ?? null };
}

/** Google can't be used until the user signs in with Google again (or for the first time): the step waits for them. */
export class GoogleNeedsMe extends Error {}

/** A minute less than Google says, so a token never expires mid-call. */
const EARLY_MS = 60_000;

/**
 * The user's Google accounts for the calendar steps (M14-T1) and topics' Drive folders (M43-T2), several since M50-T8:
 * the one asked for, else the default. A refresh token is opened only here, for a fresh access token (kept in memory until shortly before it expires). Google refusing it
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
    who: GoogleWho,
    method: "GET" | "POST",
    path: string,
    query: Record<string, string> = {},
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const url = `${this.apiBase}${path}${Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : ""}`;
    const response = await this.request(who, "calendar", url, {
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
  async request(who: GoogleWho, service: GoogleService, url: string, init: RequestInit = {}): Promise<Response> {
    const { scope, name } = SERVICES[service];
    for (let attempt = 1; ; attempt++) {
      const { token, scopes, accountId, email } = await this.accessToken(who);
      // Connected before this service was asked for, or left unticked: only a reconnect adds it.
      if (!scopes.includes(scope))
        throw new GoogleNeedsMe(`Storm's access to ${email} doesn't include ${name}: reconnect it in Settings and allow it`);
      const response = await this.send(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status === 401) {
        this.tokens.delete(accountId);
        if (attempt === 1) continue;
        throw await this.broken(accountId, `Google no longer accepts Storm's access to ${email}`);
      }
      if (response.status === 403) {
        const text = await response.clone().text();
        if (/insufficient|ACCESS_TOKEN_SCOPE/i.test(text))
          throw new GoogleNeedsMe(`Storm's access to ${email} doesn't include ${name}: reconnect it in Settings and allow it`);
      }
      if (response.ok) await this.worked(accountId);
      return response;
    }
  }

  /** The account asked for (the user's), else the default; a fresh access token for it, cached until shortly before it expires. */
  private async accessToken(who: GoogleWho): Promise<{ token: string; scopes: string[]; accountId: string; email: string }> {
    const { clientId, clientSecret } = this.options;
    if (!clientId || !clientSecret) throw new Error("Google isn't set up: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are empty (.env)");
    const row = who.account
      ? await this.prisma.googleAccount.findFirst({ where: { googleAccountId: who.account, userId: who.userId } })
      : await this.prisma.googleAccount.findFirst({
          where: { userId: who.userId },
          orderBy: [{ isDefault: "desc" }, { dateCreated: "asc" }],
        });
    if (!row)
      throw new GoogleNeedsMe(
        who.account ? "That Google account is no longer connected: choose another" : "Google isn't connected: connect it in Settings",
      );
    const cached = this.tokens.get(row.googleAccountId);
    if (cached && cached.expiresAt > Date.now()) return { ...cached, accountId: row.googleAccountId, email: row.email };
    if (row.status === "NEEDS_RECONNECT") throw new GoogleNeedsMe(row.brokenReason ?? `${row.email} needs reconnecting`);
    const result = await refreshGoogleToken(this.send, { clientId, clientSecret }, open(this.keys, row.googleAccountId, row));
    if (!result.ok) {
      if (result.reconnect) throw await this.broken(row.googleAccountId, `${row.email}: ${result.error}: it was revoked or has expired`);
      throw new Error(result.error);
    }
    // What the refresh grants (Google says it); the sign-in's scopes when it doesn't.
    const fresh = {
      token: result.accessToken,
      scopes: result.scopes.length ? result.scopes : row.scopes,
      expiresAt: Date.now() + result.expiresIn * 1000 - EARLY_MS,
    };
    this.tokens.set(row.googleAccountId, fresh);
    return { ...fresh, accountId: row.googleAccountId, email: row.email };
  }

  private async broken(googleAccountId: string, reason: string): Promise<GoogleNeedsMe> {
    this.tokens.delete(googleAccountId);
    await this.prisma.googleAccount.updateMany({
      where: { googleAccountId, status: "CONNECTED" },
      data: { status: "NEEDS_RECONNECT", brokenAt: new Date(), brokenReason: reason },
    });
    return new GoogleNeedsMe(reason);
  }

  private async worked(googleAccountId: string): Promise<void> {
    await this.prisma.googleAccount.updateMany({ where: { googleAccountId }, data: { lastWorkedAt: new Date() } });
  }
}

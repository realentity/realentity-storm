import { KeyRing, seal } from "@ai-me/crypto";
import {
  emailOfIdToken,
  exchangeGoogleCode,
  googleAuthUrl,
  GOOGLE_SCOPES,
  type GoogleClient,
  type GoogleStatusView,
  type ServerEnv,
} from "@ai-me/shared";
import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { SERVER_ENV } from "../config/server-env";
import { PrismaService } from "../database/prisma.service";

export const GOOGLE_FETCH = Symbol("GOOGLE_FETCH");

/** A sign-in that wasn't finished within this long is forgotten. */
const PENDING_MS = 10 * 60_000;
const CALENDAR_SCOPE = GOOGLE_SCOPES[2];

interface Pending {
  userId: string;
  verifier: string;
  returnTo: string;
  expiresAt: number;
}

/**
 * Google Calendar's connection (M14-T1): the consent screen, the code exchanged for a refresh token (sealed, AAD =
 * userId; only the worker opens it), the state as last seen, and disconnecting. Connecting again continues the runs
 * waiting for it. Sign-ins in progress are kept in memory (one api process): a restart only means signing in again.
 */
@Injectable()
export class GoogleService {
  private readonly logger = new Logger(GoogleService.name);
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: KeyRing,
    @Inject(SERVER_ENV) private readonly env: ServerEnv,
    @Inject(GOOGLE_FETCH) private readonly send: typeof fetch,
  ) {}

  async status(userId: string, origin: string): Promise<GoogleStatusView> {
    const row = await this.prisma.client.googleConnection.findUnique({ where: { userId } });
    return {
      configured: Boolean(this.env.GOOGLE_CLIENT_ID && this.env.GOOGLE_CLIENT_SECRET),
      redirectUri: this.redirectUri(origin),
      connected: row !== null,
      email: row?.email ?? null,
      status: row?.status ?? null,
      lastWorkedAt: row?.lastWorkedAt?.toISOString() ?? null,
      brokenAt: row?.brokenAt?.toISOString() ?? null,
      brokenReason: row?.brokenReason ?? null,
    };
  }

  /** The consent screen's address; `returnTo` is the page to come back to (a path of this app). */
  async connect(userId: string, origin: string, returnTo = "/settings"): Promise<{ url: string }> {
    const client = this.client(origin);
    if (!returnTo.startsWith("/") || returnTo.startsWith("//")) throw new BadRequestException("returnTo must be a path of AI ME");
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    this.forgetOld();
    this.pending.set(state, { userId, verifier, returnTo, expiresAt: Date.now() + PENDING_MS });
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const known = await this.prisma.client.googleConnection.findUnique({ where: { userId }, select: { email: true } });
    return { url: googleAuthUrl(client, state, challenge, known?.email) };
  }

  /**
   * Back from Google: the page to go to, with ?google=connected or ?google=<what went wrong>. The browser comes from
   * accounts.google.com, so my SameSite=Strict session cookie isn't sent: the user is the one who started this sign-in,
   * known by its state (random, used once, 10 minutes, and bound to the PKCE verifier Google checks).
   */
  async callback(origin: string, query: { code?: string; state?: string; error?: string }): Promise<string> {
    const pending = query.state ? this.pending.get(query.state) : undefined;
    if (query.state) this.pending.delete(query.state);
    if (!pending || pending.expiresAt < Date.now()) return back("/settings", "the sign-in expired or wasn't started here: connect again");
    const { userId } = pending;
    if (query.error) return back(pending.returnTo, query.error === "access_denied" ? "you didn't allow access" : `Google said ${query.error}`);
    if (!query.code) return back(pending.returnTo, "Google sent no code");

    const result = await exchangeGoogleCode(this.send, this.client(origin), query.code, pending.verifier);
    if (!result.ok) return back(pending.returnTo, result.error);
    if (!result.scopes.includes(CALENDAR_SCOPE)) return back(pending.returnTo, "the calendar wasn't allowed: connect again and tick the calendar access");
    if (!result.refreshToken) {
      return back(pending.returnTo, "Google sent no refresh token: remove AI ME at myaccount.google.com/permissions, then connect again");
    }
    const email = (result.idToken && emailOfIdToken(result.idToken)) || "your Google account";
    const sealed = seal(this.keys, userId, result.refreshToken);
    const data = { email, scopes: result.scopes, status: "CONNECTED" as const, ...sealed, lastWorkedAt: new Date(), brokenAt: null, brokenReason: null };
    await this.prisma.client.googleConnection.upsert({ where: { userId }, create: { userId, ...data }, update: data });

    // The runs that waited for this go on (the worker sees the takeover continued).
    const { count } = await this.prisma.client.takeover.updateMany({
      where: { waitsFor: "google", status: "OPEN", run: { userId } },
      data: { status: "CONTINUED", resolvedAt: new Date() },
    });
    if (count) this.logger.log(`Google Calendar connected: ${count} waiting run(s) continue`);
    return back(pending.returnTo, "connected");
  }

  /**
   * Forgets the token. Only the worker opens secrets, so the api doesn't revoke it at Google: Settings links to
   * myaccount.google.com/permissions for that.
   */
  async disconnect(userId: string): Promise<void> {
    await this.prisma.client.googleConnection.deleteMany({ where: { userId } });
  }

  redirectUri(origin: string): string {
    return `${this.env.APP_ORIGIN ?? origin}/api/google/callback`;
  }

  private client(origin: string): GoogleClient {
    const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = this.env;
    if (!clientId || !clientSecret) throw new BadRequestException("Google Calendar isn't set up: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env");
    return { clientId, clientSecret, redirectUri: this.redirectUri(origin) };
  }

  private forgetOld(): void {
    for (const [state, entry] of this.pending) if (entry.expiresAt < Date.now()) this.pending.delete(state);
  }
}

function back(path: string, outcome: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}google=${encodeURIComponent(outcome)}#google`;
}

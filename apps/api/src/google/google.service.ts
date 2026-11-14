import { KeyRing, seal } from "@realentity/storm-crypto";
import {
  CALENDAR_SCOPE,
  DRIVE_SCOPE,
  emailOfIdToken,
  exchangeGoogleCode,
  googleAuthUrl,
  type GoogleAccountView,
  type GoogleClient,
  type GoogleStatusView,
  type ServerEnv,
} from "@realentity/storm-shared";
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SERVER_ENV } from "../config/server-env";
import { PrismaService } from "../database/prisma.service";

export const GOOGLE_FETCH = Symbol("GOOGLE_FETCH");

/** A sign-in that wasn't finished within this long is forgotten. */
const PENDING_MS = 10 * 60_000;

interface Pending {
  userId: string;
  verifier: string;
  returnTo: string;
  expiresAt: number;
}

/**
 * The user's Google accounts (M50-T8: several, one the default), for the calendar (M14-T1) and topics' Drive folders
 * (M43-T2): the consent screen, the code exchanged for a refresh token (sealed, AAD = the account's id; only the worker
 * opens it), each account's state as last seen, and removing one. The address Google signs in as is the account: signing
 * in as one already there reconnects it. Connecting again continues the runs
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
    const rows = await this.prisma.client.googleAccount.findMany({ where: { userId }, orderBy: [{ isDefault: "desc" }, { email: "asc" }] });
    const bindings = await this.prisma.client.binding.findMany({
      where: { googleAccountId: { in: rows.map((r) => r.googleAccountId) } },
      include: { pipeline: { select: { name: true } }, app: { select: { name: true } } },
      orderBy: { slot: "asc" },
    });
    const accounts: GoogleAccountView[] = rows.map((row) => ({
      googleAccountId: row.googleAccountId,
      email: row.email,
      status: row.status,
      isDefault: row.isDefault,
      calendar: row.scopes.includes(CALENDAR_SCOPE),
      drive: row.scopes.includes(DRIVE_SCOPE),
      lastWorkedAt: row.lastWorkedAt?.toISOString() ?? null,
      brokenAt: row.brokenAt?.toISOString() ?? null,
      brokenReason: row.brokenReason,
      usedBy: bindings
        .filter((b) => b.googleAccountId === row.googleAccountId)
        .map((b) =>
          b.pipelineId
            ? { owner: "pipeline" as const, id: b.pipelineId, name: b.pipeline?.name ?? "", slot: b.slot }
            : { owner: "app" as const, id: b.appId ?? "", name: b.app?.name ?? "", slot: b.slot },
        ),
    }));
    return {
      configured: Boolean(this.env.GOOGLE_CLIENT_ID && this.env.GOOGLE_CLIENT_SECRET),
      redirectUri: this.redirectUri(origin),
      accounts,
    };
  }

  /**
   * The consent screen's address; `returnTo` is the page to come back to (a path of this app). With `account`, signing
   * in as that one (reconnecting it); without, choosing an account (another one is added).
   */
  async connect(userId: string, origin: string, returnTo = "/settings", account?: string): Promise<{ url: string }> {
    const client = this.client(origin);
    if (!returnTo.startsWith("/") || returnTo.startsWith("//")) throw new BadRequestException("returnTo must be a path of Storm");
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    this.forgetOld();
    this.pending.set(state, { userId, verifier, returnTo, expiresAt: Date.now() + PENDING_MS });
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const known = account
      ? await this.prisma.client.googleAccount.findFirst({ where: { googleAccountId: account, userId }, select: { email: true } })
      : null;
    if (account && !known) throw new NotFoundException();
    return { url: googleAuthUrl(client, state, challenge, known?.email) };
  }

  /**
   * Back from Google: the page to go to, with ?google=connected or ?google=<what went wrong>. The browser comes from
   * accounts.google.com, so the SameSite=Strict session cookie isn't sent: the user is the one who started this sign-in,
   * known by its state (random, used once, 10 minutes, and bound to the PKCE verifier Google checks).
   */
  async callback(origin: string, query: { code?: string; state?: string; error?: string }): Promise<string> {
    const pending = query.state ? this.pending.get(query.state) : undefined;
    if (query.state) this.pending.delete(query.state);
    if (!pending || pending.expiresAt < Date.now()) return back("/settings", "the sign-in expired or wasn't started here: connect again");
    const { userId } = pending;
    if (query.error)
      return back(pending.returnTo, query.error === "access_denied" ? "you didn't allow access" : `Google said ${query.error}`);
    if (!query.code) return back(pending.returnTo, "Google sent no code");

    const result = await exchangeGoogleCode(this.send, this.client(origin), query.code, pending.verifier);
    if (!result.ok) return back(pending.returnTo, result.error);
    // Either is enough: the other one's steps say it wasn't allowed.
    if (!result.scopes.includes(CALENDAR_SCOPE) && !result.scopes.includes(DRIVE_SCOPE)) {
      return back(pending.returnTo, "neither the calendar nor Drive was allowed: connect again and tick them");
    }
    if (!result.refreshToken) {
      return back(pending.returnTo, "Google sent no refresh token: remove Storm at myaccount.google.com/permissions, then connect again");
    }
    const email = ((result.idToken && emailOfIdToken(result.idToken)) || "your Google account").toLowerCase();
    // The same address again: that account, reconnected (a new token, sealed to its id); another: a new account.
    const existing = await this.prisma.client.googleAccount.findUnique({ where: { userId_email: { userId, email } } });
    const googleAccountId = existing?.googleAccountId ?? randomUUID();
    const sealed = seal(this.keys, googleAccountId, result.refreshToken);
    const data = {
      scopes: result.scopes,
      status: "CONNECTED" as const,
      ...sealed,
      lastWorkedAt: new Date(),
      brokenAt: null,
      brokenReason: null,
    };
    if (existing) await this.prisma.client.googleAccount.update({ where: { googleAccountId }, data });
    else {
      const first = (await this.prisma.client.googleAccount.count({ where: { userId } })) === 0;
      await this.prisma.client.googleAccount.create({ data: { googleAccountId, userId, email, isDefault: first, ...data } });
    }

    // The runs that waited for this go on (the worker sees the takeover continued).
    const { count } = await this.prisma.client.takeover.updateMany({
      where: { waitsFor: "google", status: "OPEN", run: { userId } },
      data: { status: "CONTINUED", resolvedAt: new Date() },
    });
    if (count) this.logger.log(`Google connected: ${count} waiting run(s) continue`);
    return back(pending.returnTo, "connected");
  }

  /** Makes one the default: the one used where no account is chosen. */
  async makeDefault(userId: string, googleAccountId: string): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      if ((await tx.googleAccount.count({ where: { googleAccountId, userId } })) === 0) throw new NotFoundException();
      await tx.googleAccount.updateMany({ where: { userId }, data: { isDefault: false } });
      await tx.googleAccount.update({ where: { googleAccountId }, data: { isDefault: true } });
    });
  }

  /**
   * Forgets one account's token; the oldest left becomes the default if it was. Only the worker opens secrets, so the
   * api doesn't revoke it at Google: Settings links to myaccount.google.com/permissions for that.
   */
  async disconnect(userId: string, googleAccountId: string): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      const { count } = await tx.googleAccount.deleteMany({ where: { googleAccountId, userId } });
      if (count === 0) throw new NotFoundException();
      if ((await tx.googleAccount.count({ where: { userId, isDefault: true } })) > 0) return;
      const next = await tx.googleAccount.findFirst({
        where: { userId },
        orderBy: { dateCreated: "asc" },
        select: { googleAccountId: true },
      });
      if (next) await tx.googleAccount.update({ where: { googleAccountId: next.googleAccountId }, data: { isDefault: true } });
    });
  }

  redirectUri(origin: string): string {
    return `${this.env.APP_ORIGIN ?? origin}/api/google/callback`;
  }

  private client(origin: string): GoogleClient {
    const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = this.env;
    if (!clientId || !clientSecret)
      throw new BadRequestException("Google isn't set up: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env");
    return { clientId, clientSecret, redirectUri: this.redirectUri(origin) };
  }

  private forgetOld(): void {
    for (const [state, entry] of this.pending) if (entry.expiresAt < Date.now()) this.pending.delete(state);
  }
}

function back(path: string, outcome: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}google=${encodeURIComponent(outcome)}#google`;
}

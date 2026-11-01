/**
 * Google OAuth for the calendar (M14-T1), shared by the api (connect: the consent screen, the code exchanged for a
 * refresh token) and the worker (an access token from the refresh token). Plain HTTPS calls; `fetch` is injected so
 * tests answer for Google.
 */

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/** My address (the id token's email) and my calendars' events: read, create. */
export const GOOGLE_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.events"] as const;

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
  /** APP_ORIGIN + /api/google/callback: registered on the Google client. */
  redirectUri: string;
}

/** The consent screen: offline (a refresh token), always asking, so a reconnect gets a new refresh token. */
export function googleAuthUrl(client: GoogleClient, state: string, codeChallenge: string, loginHint?: string): string {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export type GoogleTokenResult =
  | { ok: true; accessToken: string; expiresIn: number; refreshToken: string | null; idToken: string | null; scopes: string[] }
  /** `reconnect`: Google refused the grant (revoked, expired): only signing in again helps. */
  | { ok: false; error: string; reconnect: boolean };

/** The sign-in's code for tokens (the api, on the callback). */
export function exchangeGoogleCode(send: typeof fetch, client: GoogleClient, code: string, codeVerifier: string): Promise<GoogleTokenResult> {
  return tokenRequest(send, {
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    redirect_uri: client.redirectUri,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
}

/** A fresh access token from the refresh token (the worker, when a calendar step runs). */
export function refreshGoogleToken(send: typeof fetch, client: Omit<GoogleClient, "redirectUri">, refreshToken: string): Promise<GoogleTokenResult> {
  return tokenRequest(send, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });
}

async function tokenRequest(send: typeof fetch, form: Record<string, string>): Promise<GoogleTokenResult> {
  let response: Response;
  try {
    response = await send(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return { ok: false, error: `Google didn't answer: ${error instanceof Error ? error.message : String(error)}`, reconnect: false };
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof body.access_token !== "string") {
    const code = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
    const detail = typeof body.error_description === "string" ? `: ${body.error_description}` : "";
    // invalid_grant: the refresh token was revoked or expired (or the code was used); invalid_client is my setup.
    return { ok: false, error: `Google refused the token (${code}${detail})`, reconnect: code === "invalid_grant" };
  }
  return {
    ok: true,
    accessToken: body.access_token,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : 3600,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    idToken: typeof body.id_token === "string" ? body.id_token : null,
    scopes: typeof body.scope === "string" ? body.scope.split(" ") : [],
  };
}

/** The address in an id token (it came straight from Google's token endpoint over TLS, so it isn't verified again). */
export function emailOfIdToken(idToken: string): string | null {
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(new TextDecoder().decode(base64UrlBytes(payload))) as { email?: unknown };
    return typeof json.email === "string" ? json.email : null;
  } catch {
    return null;
  }
}

function base64UrlBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/** A field-level validation error, as the api returns them (names the field, never echoes the value). */
export interface FieldError {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly errors: FieldError[] = [],
  ) {
    super(message);
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

/** Called when a request comes back 401 (session expired or revoked), so the app can show the login page. */
export function onUnauthorized(listener: Listener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

/**
 * Same-origin JSON requests with the session cookie. The api is at /api on the same host (Vite proxies it in
 * development, Caddy in production), so there is no token in JavaScript.
 */
export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return undefined as T;
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const problem = (data ?? {}) as { message?: unknown; errors?: unknown };
    if (response.status === 401 && path !== "/auth/login") unauthorizedListeners.forEach((listener) => listener());
    throw new ApiError(
      response.status,
      typeof problem.message === "string" ? problem.message : response.statusText || `HTTP ${response.status}`,
      Array.isArray(problem.errors) ? (problem.errors as FieldError[]) : [],
    );
  }
  return data as T;
}

/** A query string from the set values only. */
export function query(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

/** A readable message for any error a request can throw. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

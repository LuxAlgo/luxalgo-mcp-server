/*
  The one HTTP client for the LuxAlgo app API (JSON, `{data, errors}`
  envelope) and the marketing site's plain-markdown routes. Domain modules
  wrap specific endpoints on top of this (tools/library/api.ts,
  tools/propfirms/api.ts, tools/journal/api.ts, tools/account/tools.ts).

  Reads (`appGet`) work without credentials. When the caller has signed in
  with LuxAlgo, though, every app request carries their OAuth access token
  (see auth/access-context.ts): the app resolves the user from it exactly as
  from a browser session, and it — never this server — decides what that
  user may see. Writes (`appSend`) always need that token — the user's own
  journal is the only thing this server ever writes, and only as them. The
  app's answers map to two typed errors: 401 → sign in (AppAuthError),
  403 → the plan does not allow it (AppPermissionError).
*/
import { currentAccess, type Access } from "../auth/access-context.js";

export const APP_API_ORIGIN = process.env.LUXALGO_APP_ORIGIN ?? "https://app.luxalgo.com";
export const SITE_ORIGIN = process.env.LUXALGO_SITE_ORIGIN ?? "https://www.luxalgo.com";

export class AppApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** The app wants a signed-in user for this and the request carried no valid token. */
export class AppAuthError extends AppApiError {
  constructor(pathname: string) {
    super(`LuxAlgo API needs a signed-in user for ${pathname}`, 401);
  }
}

/** The user is known but their plan (or role) does not allow this. */
export class AppPermissionError extends AppApiError {
  constructor(
    message: string,
    /** The failing permission key when the app named one (`details.permission`). */
    readonly permission: string | undefined,
  ) {
    super(message, 403);
  }
}

/** True for the app's "no such thing" answers (404, or an explicit not-found error message). */
export function isNotFound(error: unknown): boolean {
  return error instanceof AppApiError && (error.status === 404 || /404|not found/i.test(error.message));
}

type ApiErrorBody = { message: string; details?: { permission?: unknown } };

export type AppGetOptions = {
  /**
   * Token to call the app with. Defaults to the ambient one for the current
   * tool call (auth/access-context.ts); pass `null` to call anonymously.
   */
  access?: Access | null;
};

export async function appGet<T>(
  pathname: string,
  query?: Record<string, string | undefined>,
  options: AppGetOptions = {},
): Promise<T> {
  const access = options.access === undefined ? currentAccess() : options.access;
  const headers: Record<string, string> = { accept: "application/json" };
  if (access) headers.authorization = `Bearer ${access.token}`;
  return readEnvelope<T>(pathname, await fetch(appUrl(pathname, query), { headers }));
}

export type AppSendOptions = {
  query?: Record<string, string | undefined>;
  /** JSON-encoded request body; omit for body-less requests. */
  body?: unknown;
};

/**
 * A write to the app (POST / PATCH / PUT / DELETE) as the signed-in user.
 * Always sends the ambient token — there is no anonymous form, because a
 * write on nobody's behalf is never meaningful here — and throws the same
 * AppAuthError the app would answer when no token is present, so a caller
 * without one gets the sign-in challenge before any request goes out.
 */
export async function appSend<T>(
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  pathname: string,
  options: AppSendOptions = {},
): Promise<T> {
  const access = currentAccess();
  if (!access) throw new AppAuthError(pathname);
  const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${access.token}` };
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  return readEnvelope<T>(pathname, await fetch(appUrl(pathname, options.query), init));
}

function appUrl(pathname: string, query?: Record<string, string | undefined>): URL {
  const url = new URL(pathname, APP_API_ORIGIN);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  return url;
}

/**
 * Unwraps the app's `{data, errors}` envelope. 401 and 403 become the typed
 * errors above; any other failure carries the app's own message when it sent
 * one (routes answer 400/404 with a plain-language reason — "Trade not found",
 * "Nothing to update" — which is what the caller needs to recover) and a
 * generic status line otherwise.
 */
async function readEnvelope<T>(pathname: string, response: Response): Promise<T> {
  const text = await response.text();
  let payload: { data?: T; errors?: ApiErrorBody[] } | undefined;
  try {
    payload = JSON.parse(text) as { data?: T; errors?: ApiErrorBody[] };
  } catch {
    payload = undefined;
  }
  const firstError = payload?.errors?.[0];

  if (response.status === 401) throw new AppAuthError(pathname);
  if (response.status === 403) {
    const permission = firstError?.details?.permission;
    throw new AppPermissionError(
      firstError?.message ?? `LuxAlgo API 403 for ${pathname}`,
      typeof permission === "string" ? permission : undefined,
    );
  }
  if (!response.ok) {
    throw new AppApiError(firstError?.message ?? `LuxAlgo API ${response.status} for ${pathname}`, response.status);
  }
  if (payload === undefined) throw new AppApiError(`Non-JSON response for ${pathname}`, response.status);
  if (firstError) throw new AppApiError(firstError.message, response.status);
  if (payload.data === undefined) throw new AppApiError(`Empty response for ${pathname}`, response.status);
  return payload.data;
}

/** Plain-markdown page from the marketing site; null on 404. */
export async function fetchMarkdown(path: string): Promise<string | null> {
  const response = await fetch(new URL(path, SITE_ORIGIN), {
    headers: { accept: "text/markdown, text/plain" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new AppApiError(`LuxAlgo site ${response.status} for ${path}`);
  return await response.text();
}

/**
 * In-process cache for small, rarely changing, caller-independent data
 * (fetched anonymously — never a personalised view). One entry per loader.
 */
export function cachedAnonymous<T>(ttlMs: number, load: () => Promise<T>): () => Promise<T> {
  let cache: { at: number; value: T } | null = null;
  return async () => {
    if (cache && Date.now() - cache.at < ttlMs) return cache.value;
    const value = await load();
    cache = { at: Date.now(), value };
    return value;
  };
}

/*
  The interactive sign-in for the local server: OAuth 2.1 authorization
  code + PKCE with a loopback redirect (RFC 8252 §7.3), driven by the MCP
  SDK's `auth()` and this file's tiny one-shot HTTP listener on 127.0.0.1.

    1. listen on a random loopback port; that is the redirect_uri
    2. auth() discovers our resource metadata → the app's issuer, picks the
       client identity (CIMD or DCR), builds the authorization URL and hands
       it to `present` (open a browser, print it, or elicit it via the MCP
       client) — or returns AUTHORIZED right away if a stored refresh token
       still works
    3. the app redirects the browser back with ?code&state; we check state,
       exchange the code (auth() again, with the code) and persist tokens

  Used by `luxalgo-mcp login` and, when the MCP client supports URL-mode
  elicitation, by protected tools mid-session (runtime.ts).
*/
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { auth, OAuthError } from "@modelcontextprotocol/client";
import { AUTH_ISSUER, MCP_RESOURCE, OAUTH_SCOPES } from "../config.js";
import { LocalOAuthProvider } from "./provider.js";
import { readStoredAuth, type StoredAuth } from "./store.js";

export type SignInOptions = {
  /** Deliver the authorization URL to the user. */
  present: (url: URL) => void | Promise<void>;
  /** Give up waiting for the browser after this long. Default 5 minutes. */
  timeoutMs?: number;
  /** Skip the refresh shortcut and always run the browser flow. */
  force?: boolean;
};

export type SignInOutcome = { kind: "refreshed" } | { kind: "signed-in" };

type Callback = { code: string; state?: string; iss?: string } | { error: string; description?: string };

export async function signIn(options: SignInOptions): Promise<SignInOutcome> {
  const { server, port, callback } = await listenForCallback(options.timeoutMs ?? 5 * 60_000);
  try {
    const redirectUrl = new URL(`http://127.0.0.1:${port}/callback`);
    const provider = new LocalOAuthProvider({ redirectUrl, onAuthorizationUrl: options.present });

    const first = await auth(provider, {
      serverUrl: MCP_RESOURCE,
      scope: OAUTH_SCOPES.join(" "),
      forceReauthorization: options.force,
    });
    if (first === "AUTHORIZED") return { kind: "refreshed" };

    const result = await callback;
    if ("error" in result) {
      throw new Error(`Sign-in was not completed: ${result.error}${result.description ? ` — ${result.description}` : ""}`);
    }
    if (result.state !== provider.expectedState()) {
      throw new Error("Sign-in rejected: state mismatch (the callback did not belong to this attempt)");
    }
    const second = await auth(provider, { serverUrl: MCP_RESOURCE, authorizationCode: result.code, iss: result.iss });
    if (second !== "AUTHORIZED") throw new Error("Sign-in did not complete (unexpected redirect on code exchange)");
    return { kind: "signed-in" };
  } finally {
    server.close();
  }
}

/**
 * Refresh the stored tokens without any user interaction. False when a
 * sign-in is needed. Concurrent callers share one refresh: the app rotates
 * refresh tokens, so two parallel attempts would have the second one fail
 * with invalid_grant and wrongly conclude the user is signed out.
 */
export function refreshQuietly(): Promise<boolean> {
  return (refreshInFlight ??= doRefresh().finally(() => (refreshInFlight = undefined)));
}
let refreshInFlight: Promise<boolean> | undefined;

async function doRefresh(): Promise<boolean> {
  // A redirectUrl must exist or the SDK treats the flow as client_credentials;
  // it is never reached because redirectToAuthorization throws instead.
  const provider = new LocalOAuthProvider({ redirectUrl: new URL("http://127.0.0.1/callback") });
  const before = (await readStoredAuth({ issuer: AUTH_ISSUER, resource: MCP_RESOURCE }))?.tokens?.refresh_token;
  try {
    return (await auth(provider, { serverUrl: MCP_RESOURCE })) === "AUTHORIZED";
  } catch (error) {
    if (error instanceof OAuthError) {
      // The app rejected the refresh token (revoked, consent withdrawn). Only
      // drop the stored tokens if they are still the ones that just failed —
      // another process (e.g. `login`) may have saved fresh ones meanwhile.
      const now = (await readStoredAuth({ issuer: AUTH_ISSUER, resource: MCP_RESOURCE }))?.tokens?.refresh_token;
      if (now === before) await provider.invalidateCredentials("tokens");
    }
    return false;
  }
}

/** Open the URL in the default browser; never throws (the URL is always printed too). */
export function openInBrowser(url: URL): void {
  const target = url.toString();
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [target]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", target.replace(/&/g, "^&")]]
        : ["xdg-open", [target]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // no browser available — the caller printed the URL
  }
}

/** Unverified peek at the access token's claims, for display only (the app verifies for real). */
export function peekClaims(tokens: StoredAuth["tokens"]): { sub?: string; email?: string; exp?: number } {
  const [, payload] = tokens?.access_token.split(".") ?? [];
  if (!payload) return {};
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    return {
      ...(typeof claims.sub === "string" ? { sub: claims.sub } : {}),
      ...(typeof claims.email === "string" ? { email: claims.email } : {}),
      ...(typeof claims.exp === "number" ? { exp: claims.exp } : {}),
    };
  } catch {
    return {};
  }
}

function listenForCallback(timeoutMs: number): Promise<{ server: Server; port: number; callback: Promise<Callback> }> {
  return new Promise((resolveListen, rejectListen) => {
    let settle!: (result: Callback) => void;
    let fail!: (error: Error) => void;
    const callback = new Promise<Callback>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      if (error || !code) {
        res.end(page("Sign-in not completed", `The LuxAlgo sign-in did not finish (${error ?? "no code returned"}). You can close this tab and try again.`));
        settle({ error: error ?? "invalid_response", description: url.searchParams.get("error_description") ?? undefined });
        return;
      }
      res.end(page("You're signed in", "LuxAlgo MCP can now use your account. You can close this tab and return to your AI client."));
      settle({ code, state: url.searchParams.get("state") ?? undefined, iss: url.searchParams.get("iss") ?? undefined });
    });

    const timer = setTimeout(() => fail(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the browser sign-in`)), timeoutMs);
    timer.unref();
    server.on("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectListen(new Error("Could not open a loopback port for the sign-in redirect"));
        return;
      }
      resolveListen({ server, port: address.port, callback: callback.finally(() => clearTimeout(timer)) });
    });
  });
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title} · LuxAlgo MCP</title>
<body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#111">
<h1 style="font-size:1.4rem">${title}</h1><p>${body}</p></body>`;

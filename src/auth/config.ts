/*
  OAuth wiring shared by every entry. This server is an OAuth 2.1 protected
  resource (RFC 9728); the LuxAlgo app is its authorization server. Nothing
  here mints tokens — the app does that (/api/auth/oauth2/*) after the user
  signs in and approves consent; this server only verifies what it is handed
  and tells clients where to go when it is handed nothing.

  Two identifiers must match the app's configuration byte for byte:
    AUTH_ISSUER   the app's better-auth issuer (its `iss` claim, and where
                  RFC 8414 metadata + JWKS live) — `<app origin>/api/auth`,
                  following the same LUXALGO_APP_ORIGIN the other tools use
    MCP_RESOURCE  this server's canonical URL — the token audience (`aud`)
                  and the `resource` clients send per RFC 8707
  Local development against a local app checkout: LUXALGO_APP_ORIGIN=
  http://localhost:3001 MCP_RESOURCE=http://localhost:3333/mcp (and the app's
  LUXALGO_MCP_SERVER_RESOURCE set to the same value).
*/
import { APP_API_ORIGIN } from "../platform/app-client.js";

const trimmed = (value: string | undefined): string | undefined => {
  const v = value?.trim();
  return v ? v : undefined;
};

/** Origin of the app — the authorization server, and the API every tool forwards the user's token to. */
export const APP_ORIGIN = APP_API_ORIGIN.replace(/\/+$/, "");

/** better-auth issuer of the LuxAlgo app (RFC 8414 metadata + JWKS live under it). */
export const AUTH_ISSUER = `${APP_ORIGIN}/api/auth`;

/** This server's RFC 8707 resource identifier = token audience. */
export const MCP_RESOURCE = trimmed(process.env.MCP_RESOURCE) ?? "https://mcp.luxalgo.com/mcp";

export const MCP_ORIGIN = new URL(MCP_RESOURCE).origin;

/** JWKS the access tokens are verified against (served by the app's jwt() plugin). */
export const JWKS_URL = `${AUTH_ISSUER}/jwks`;

/**
 * RFC 9728: the metadata document lives at the well-known root and, for a
 * resource with a path, also at the path-inserted form. Clients try the
 * path-inserted form first (MCP SDK), some only the root — serve both.
 */
export const PRM_ROOT_PATH = "/.well-known/oauth-protected-resource";
export const PRM_PATH = `${PRM_ROOT_PATH}${new URL(MCP_RESOURCE).pathname.replace(/\/+$/, "")}`;

export const PRM_URL = `${MCP_ORIGIN}${PRM_PATH}`;

/**
 * The Claude-only address — a workaround for a claude.ai bug
 * (anthropics/claude-ai-mcp#1013), not a second product. claude.ai's broker
 * probes the well-known PRM at connect time and treats its existence as
 * "always requires sign-in", starting OAuth before any 401 — so on this host
 * the well-known forms answer 404 and the document lives at CLAUDE_PRM_PATH,
 * a URL clients only learn from the 401's `resource_metadata`: discovery is
 * purely reactive (the trick from the official lazy-auth example,
 * modelcontextprotocol/ext-apps examples/lazy-auth-server,
 * REACTIVE_AUTH_ONLY). Every other client uses MCP_RESOURCE, which stays
 * standard RFC 9728.
 *
 * Same server, same tools, but its own resource identifier: tokens minted
 * for it carry this audience. The host is MCP_RESOURCE's with `claude.` in
 * front — https://claude.mcp.luxalgo.com/mcp in production, and
 * http://claude.localhost:3333/mcp for a local MCP_RESOURCE — matching the
 * app's getLuxalgoClaudeMcpServerResource(). Remove once #1013 is fixed.
 */
export const CLAUDE_MCP_RESOURCE = (() => {
  const url = new URL(MCP_RESOURCE);
  url.hostname = `claude.${url.hostname}`;
  return url.toString();
})();

/** Where the Claude host serves its PRM — outside /.well-known so connect-time probes find nothing. */
export const CLAUDE_PRM_PATH = "/auth/prm";

export const CLAUDE_PRM_URL = `${new URL(CLAUDE_MCP_RESOURCE).origin}${CLAUDE_PRM_PATH}`;

/**
 * Scopes the app's authorization server supports. `offline_access` gets a
 * refresh token, which the local (stdio) mode needs to stay signed in.
 */
export const OAUTH_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

/**
 * Client ID Metadata Document identifying the local (stdio) server as an
 * OAuth client (MCP 2026-07-28 / CIMD). It is a static file in public/ and
 * only meaningful over https, so it is undefined for a localhost resource —
 * the local client then falls back to Dynamic Client Registration, which
 * the app also allows.
 */
export const CLIENT_METADATA_URL = MCP_ORIGIN.startsWith("https://") ? `${MCP_ORIGIN}/oauth/client.json` : undefined;

/**
 * How an unauthenticated call to a protected tool is refused when the
 * client sent no token at all:
 *   "http"    HTTP 401 + WWW-Authenticate (RFC 9728 §5.1). The MCP spec's
 *             canonical flow; what Claude connectors and mcp-remote react
 *             to (default).
 *   "result"  Let the call reach the tool, which answers a tool error whose
 *             `_meta["mcp/www_authenticate"]` carries the same challenge —
 *             the shape ChatGPT's per-tool linking UI is documented to key
 *             on. (Invalid or expired tokens are always a transport 401.)
 * In both modes the protected tool itself emits the `_meta` challenge when
 * it runs without a verified identity, so the in-band signal exists
 * regardless; the switch only decides whether the transport short-circuits.
 */
export const AUTH_CHALLENGE_MODE: "http" | "result" =
  trimmed(process.env.LUXALGO_AUTH_CHALLENGE) === "result" ? "result" : "http";

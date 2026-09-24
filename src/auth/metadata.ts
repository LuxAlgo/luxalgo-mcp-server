/*
  RFC 9728 Protected Resource Metadata. This is how a client that was just
  refused learns which authorization server issues tokens for us: it reads
  `authorization_servers`, fetches that issuer's RFC 8414 document (served by
  the app's better-auth), registers (DCR or CIMD) and starts the flow.

  On the standard host it is served at both well-known forms (root and
  path-inserted). CORS is open on purpose — browser-based MCP clients (the
  inspector) fetch this document cross-origin, and it contains nothing
  secret.

  The Claude host (surface.ts) inverts the discovery surface: the well-known
  forms answer 404 so claude.ai's connect-time probe finds nothing, and the
  document — naming the Claude resource — is served at CLAUDE_PRM_PATH
  instead, a URL clients only learn from the 401's `resource_metadata`.
  /register stays 404 there, like any authless origin's: the official
  lazy-auth example answers it with an RFC 7591 "not supported" error, but
  claude.ai surfaces that 400 as a fatal "couldn't register with the sign-in
  service" (observed Sep 2026, ofid_2cd7aff4fae8efdd) rather than concluding
  "no auth here" — a 404 is the shape of the authless servers it does
  connect to.
*/
import { AUTH_ISSUER, CLAUDE_PRM_PATH, OAUTH_SCOPES, PRM_PATH, PRM_ROOT_PATH } from "./config.js";
import type { Surface } from "./surface.js";

const protectedResourceMetadata = (surface: Surface) => ({
  resource: surface.resource,
  authorization_servers: [AUTH_ISSUER],
  bearer_methods_supported: ["header"],
  scopes_supported: [...OAUTH_SCOPES],
  resource_name: "LuxAlgo MCP",
  resource_documentation: "https://github.com/LuxAlgo/luxalgo-mcp-server",
});

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "content-type, mcp-protocol-version",
  "access-control-max-age": "86400",
};

const cleanPath = (pathname: string): string => pathname.replace(/\/+$/, "") || "/";

const isWellKnown = (clean: string): boolean => clean === PRM_ROOT_PATH || clean === PRM_PATH;

/**
 * Every path this module answers, on either host. Each host serves the
 * document at its own location and answers 404 at the other's, from here
 * rather than falling through to the MCP handler, so both hosted entries
 * hide them identically.
 */
export function isProtectedResourceMetadataPath(pathname: string): boolean {
  const clean = cleanPath(pathname);
  return isWellKnown(clean) || clean === CLAUDE_PRM_PATH;
}

export function protectedResourceMetadataResponse(request: Request, surface: Surface): Response {
  const clean = cleanPath(new URL(request.url).pathname);
  const served = surface.kind === "claude" ? clean === CLAUDE_PRM_PATH : isWellKnown(clean);
  // Not this host's location — indistinguishable from an unserved path.
  if (!served) return new Response(null, { status: 404 });
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { ...CORS, allow: "GET, HEAD, OPTIONS" } });
  }
  return new Response(request.method === "HEAD" ? null : JSON.stringify(protectedResourceMetadata(surface)), {
    status: 200,
    headers: {
      ...CORS,
      "content-type": "application/json",
      "cache-control": "public, max-age=900, must-revalidate",
    },
  });
}

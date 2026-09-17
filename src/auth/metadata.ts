/*
  RFC 9728 Protected Resource Metadata. This is how a client that was just
  refused learns which authorization server issues tokens for us: it reads
  `authorization_servers`, fetches that issuer's RFC 8414 document (served by
  the app's better-auth), registers (DCR or CIMD) and starts the flow.

  Served at both well-known forms (root and path-inserted). CORS is open on
  purpose — browser-based MCP clients (the inspector) fetch this document
  cross-origin, and it contains nothing secret.

  REACTIVE_AUTH_ONLY (see config.ts) inverts the discovery surface: the
  well-known forms answer 404 so a host probing them at connect time finds
  nothing, and the document is served at PRM_REACTIVE_PATH instead — a URL
  clients only learn from the 401's `resource_metadata`. In that mode this
  module also answers POST /register: hosts whose well-known probes all 404
  can fall through to RFC 7591 dynamic client registration on this origin,
  and a proper OAuth error ("not supported here") reads as "connect without
  auth" where a bare 404 reads as a broken server (same reasoning as the
  official lazy-auth example's /register handler).
*/
import {
  AUTH_ISSUER,
  MCP_RESOURCE,
  OAUTH_SCOPES,
  PRM_PATH,
  PRM_REACTIVE_PATH,
  PRM_ROOT_PATH,
  REACTIVE_AUTH_ONLY,
} from "./config.js";

export const protectedResourceMetadata = {
  resource: MCP_RESOURCE,
  authorization_servers: [AUTH_ISSUER],
  bearer_methods_supported: ["header"],
  scopes_supported: [...OAUTH_SCOPES],
  resource_name: "LuxAlgo MCP",
  resource_documentation: "https://github.com/LuxAlgo/luxalgo-mcp-server",
} as const;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "content-type, mcp-protocol-version",
  "access-control-max-age": "86400",
};

const REGISTER_PATH = "/register";

const cleanPath = (pathname: string): string => pathname.replace(/\/+$/, "") || "/";

/**
 * Every path this module answers. The well-known forms are always ours —
 * in reactive mode they answer 404 from here rather than falling through to
 * the MCP handler, so both hosted entries hide them identically.
 */
export function isProtectedResourceMetadataPath(pathname: string): boolean {
  const clean = cleanPath(pathname);
  if (clean === PRM_ROOT_PATH || clean === PRM_PATH) return true;
  return REACTIVE_AUTH_ONLY && (clean === PRM_REACTIVE_PATH || clean === REGISTER_PATH);
}

export function protectedResourceMetadataResponse(request: Request): Response {
  if (REACTIVE_AUTH_ONLY) {
    const clean = cleanPath(new URL(request.url).pathname);
    if (clean === REGISTER_PATH) return registrationNotSupportedResponse(request);
    // The well-known forms are hidden — indistinguishable from an unserved path.
    if (clean !== PRM_REACTIVE_PATH) return new Response(null, { status: 404 });
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { ...CORS, allow: "GET, HEAD, OPTIONS" } });
  }
  return new Response(request.method === "HEAD" ? null : JSON.stringify(protectedResourceMetadata), {
    status: 200,
    headers: {
      ...CORS,
      "content-type": "application/json",
      "cache-control": "public, max-age=900, must-revalidate",
    },
  });
}

/** RFC 7591 error — this origin never registers clients; the app's authorization server does. */
function registrationNotSupportedResponse(request: Request): Response {
  if (request.method !== "POST") return new Response(null, { status: 404 });
  return new Response(
    JSON.stringify({
      error: "invalid_request",
      error_description:
        "Dynamic client registration is not supported on this origin. Authentication is requested per tool via WWW-Authenticate on 401.",
    }),
    { status: 400, headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );
}

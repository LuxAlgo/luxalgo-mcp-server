/*
  RFC 9728 Protected Resource Metadata. This is how a client that was just
  refused learns which authorization server issues tokens for us: it reads
  `authorization_servers`, fetches that issuer's RFC 8414 document (served by
  the app's better-auth), registers (DCR or CIMD) and starts the flow.

  Served at both well-known forms (root and path-inserted). CORS is open on
  purpose — browser-based MCP clients (the inspector) fetch this document
  cross-origin, and it contains nothing secret.
*/
import { AUTH_ISSUER, MCP_RESOURCE, OAUTH_SCOPES, PRM_PATH, PRM_ROOT_PATH } from "./config.js";

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

export function isProtectedResourceMetadataPath(pathname: string): boolean {
  const clean = pathname.replace(/\/+$/, "") || "/";
  return clean === PRM_ROOT_PATH || clean === PRM_PATH;
}

export function protectedResourceMetadataResponse(request: Request): Response {
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

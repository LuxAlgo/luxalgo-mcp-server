/*
  Which address a hosted request came in on. The same server answers at two:

    standard  MCP_RESOURCE (mcp.luxalgo.com) — plain RFC 9728 for every MCP
              client: well-known PRM, securitySchemes in tools/list
    claude    CLAUDE_MCP_RESOURCE (claude.mcp.luxalgo.com) — the #1013
              workaround: no well-known PRM, no securitySchemes, so claude.ai
              only learns about sign-in from a protected tool's 401

  Everything auth-related that differs between them — the PRM document and
  where it lives, the 401's `resource_metadata`, the token audience, the
  securitySchemes hint — reads the surface from here. The gate picks it from
  the request's host and makes it ambient for the rest of the request, so
  code deep in a tool call (the in-band sign-in challenge) sees it too.
  stdio never runs inside a surface and gets the standard one.
*/
import { AsyncLocalStorage } from "node:async_hooks";
import { CLAUDE_MCP_RESOURCE, CLAUDE_PRM_URL, MCP_RESOURCE, PRM_URL } from "./config.js";

export type Surface = {
  kind: "standard" | "claude";
  /** RFC 8707 resource identifier = the token audience accepted here. */
  resource: string;
  /** The PRM document's URL, as the 401's `resource_metadata` names it. */
  prmUrl: string;
  /** Whether tools/list carries the per-tool `securitySchemes` hint. */
  securitySchemes: boolean;
};

export const STANDARD_SURFACE: Surface = {
  kind: "standard",
  resource: MCP_RESOURCE,
  prmUrl: PRM_URL,
  securitySchemes: true,
};

export const CLAUDE_SURFACE: Surface = {
  kind: "claude",
  resource: CLAUDE_MCP_RESOURCE,
  prmUrl: CLAUDE_PRM_URL,
  securitySchemes: false,
};

const CLAUDE_HOST = new URL(CLAUDE_MCP_RESOURCE).host;

/**
 * The Claude surface only for its exact host; anything else — the standard
 * host, a *.vercel.app deployment URL, a bare IP — is standard. The
 * forwarded host comes first because proxies (Vercel included) rewrite Host.
 */
export function surfaceFor(request: Request): Surface {
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0] ?? request.headers.get("host") ?? new URL(request.url).host;
  return host.trim().toLowerCase() === CLAUDE_HOST ? CLAUDE_SURFACE : STANDARD_SURFACE;
}

const storage = new AsyncLocalStorage<Surface>();

export function runOnSurface<T>(surface: Surface, fn: () => T): T {
  return storage.run(surface, fn);
}

export function currentSurface(): Surface {
  return storage.getStore() ?? STANDARD_SURFACE;
}

/*
  Which address a hosted request came in on. The same server answers at three:

    standard  MCP_RESOURCE (mcp.luxalgo.com/mcp) — plain RFC 9728 for every
              MCP client: well-known PRM, securitySchemes in tools/list
    openai    OPENAI_MCP_RESOURCE (mcp.luxalgo.com/mcp/openai) — the same
              standard discovery under its own resource identifier, with the
              toolset trimmed to OpenAI's plugin directory rules (no prop-firm
              offers, promo codes or affiliate links; trackers_ticker only from
              Market Trackers)
    claude    CLAUDE_MCP_RESOURCE (claude.mcp.luxalgo.com) — the #1013
              workaround: no well-known PRM, no securitySchemes, so claude.ai
              only learns about sign-in from a protected tool's 401. A host,
              not a path: claude.ai also probes the root well-known PRM, which
              the standard host must keep serving.

  Everything that differs between them — the PRM document and where it
  lives, the 401's `resource_metadata`, the token audience, the
  securitySchemes hint, the toolset — reads the surface from here. The gate
  picks it from the request's host and path and makes it ambient for the rest
  of the request: hosted entries build the server per request, so tool
  registration sees it too. stdio never runs inside a surface and gets the
  standard one.
*/
import { AsyncLocalStorage } from "node:async_hooks";
import {
  CLAUDE_MCP_RESOURCE,
  CLAUDE_PRM_URL,
  MCP_RESOURCE,
  OPENAI_MCP_PATH,
  OPENAI_MCP_RESOURCE,
  OPENAI_PRM_URL,
  PRM_URL,
} from "./config.js";

/** "full" registers every tool as written; "openai" the directory-safe variants (see tools/*). */
export type Toolset = "full" | "openai";

export type Surface = {
  kind: "standard" | "openai" | "claude";
  /** RFC 8707 resource identifier = the token audience accepted here. */
  resource: string;
  /** The PRM document's URL, as the 401's `resource_metadata` names it. */
  prmUrl: string;
  /** Whether tools/list carries the per-tool `securitySchemes` hint. */
  securitySchemes: boolean;
  toolset: Toolset;
};

export const STANDARD_SURFACE: Surface = {
  kind: "standard",
  resource: MCP_RESOURCE,
  prmUrl: PRM_URL,
  securitySchemes: true,
  toolset: "full",
};

export const OPENAI_SURFACE: Surface = {
  kind: "openai",
  resource: OPENAI_MCP_RESOURCE,
  prmUrl: OPENAI_PRM_URL,
  securitySchemes: true,
  toolset: "openai",
};

export const CLAUDE_SURFACE: Surface = {
  kind: "claude",
  resource: CLAUDE_MCP_RESOURCE,
  prmUrl: CLAUDE_PRM_URL,
  securitySchemes: false,
  toolset: "full",
};

const CLAUDE_HOST = new URL(CLAUDE_MCP_RESOURCE).host;

/**
 * The Claude surface only for its exact host; the OpenAI surface for its
 * exact path on any other host; everything else — the standard address, a
 * *.vercel.app deployment URL, a bare IP — is standard. The forwarded host
 * comes first because proxies (Vercel included) rewrite Host.
 */
export function surfaceFor(request: Request): Surface {
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0] ?? request.headers.get("host") ?? new URL(request.url).host;
  if (host.trim().toLowerCase() === CLAUDE_HOST) return CLAUDE_SURFACE;
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  return path === OPENAI_MCP_PATH ? OPENAI_SURFACE : STANDARD_SURFACE;
}

const storage = new AsyncLocalStorage<Surface>();

export function runOnSurface<T>(surface: Surface, fn: () => T): T {
  return storage.run(surface, fn);
}

export function currentSurface(): Surface {
  return storage.getStore() ?? STANDARD_SURFACE;
}

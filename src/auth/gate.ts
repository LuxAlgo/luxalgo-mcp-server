/*
  The HTTP auth gate — "lazy authentication" (Claude's term; OpenAI calls the
  same thing anonymous discovery with auth at call time):

    • initialize, tools/list and every public tools/call are served without
      a token, so the server is fully usable before sign-in and connectors
      can enumerate tools without an OAuth popup;
    • a tools/call for a *protected* tool with no token gets the 401 + RFC
      9728 challenge that tells the client to run OAuth (or, in "result"
      mode, reaches the tool, which answers the in-band `_meta` challenge);
    • a token, whenever presented, is always verified — even on discovery —
      so a client that believes it is signed in learns about an expired or
      revoked token immediately (401) instead of silently downgrading.

  The gate is transport-agnostic: it takes a web-standard Request and hands
  the verified identity to `next`, which mounts it however its MCP handler
  wants it (mcp-handler reads `request.auth`; the SDK's handler takes an
  `authInfo` option).
*/
import { AUTH_CHALLENGE_MODE } from "./config.js";
import { unauthorizedResponse } from "./challenge.js";
import { isProtectedTool } from "../server/manifest.js";
import { TokenError, verifyAccessToken, type VerifiedToken } from "./verify.js";
import { isProtectedResourceMetadataPath, protectedResourceMetadataResponse } from "./metadata.js";

export type AuthenticatedNext = (request: Request, auth: VerifiedToken | undefined) => Promise<Response>;

export function withLuxalgoAuth(next: AuthenticatedNext): (request: Request) => Promise<Response> {
  return async (request) => {
    if (isProtectedResourceMetadataPath(new URL(request.url).pathname)) {
      return protectedResourceMetadataResponse(request);
    }

    const token = bearerToken(request.headers.get("authorization"));
    if (token !== undefined) {
      if (token.length === 0) {
        return unauthorizedResponse({ error: "invalid_request", description: "Empty bearer token" });
      }
      try {
        return await next(request, await verifyAccessToken(token));
      } catch (error) {
        if (error instanceof TokenError) {
          return unauthorizedResponse({ error: error.code, description: error.message });
        }
        throw error;
      }
    }

    if (AUTH_CHALLENGE_MODE === "http" && (await invokesProtectedTool(request))) {
      return unauthorizedResponse();
    }
    return next(request, undefined);
  };
}

/** `undefined` when there is no Bearer header at all; "" when it is present but empty. */
function bearerToken(header: string | null): string | undefined {
  if (header === null) return undefined;
  const match = /^Bearer(?:\s+(.*))?$/i.exec(header.trim());
  if (!match) return undefined; // some other scheme — not ours to judge; the MCP handler sees an anonymous request
  return (match[1] ?? "").trim();
}

/**
 * True when the JSON-RPC payload calls a protected tool (single message or
 * legacy batch). Anything unparseable is not a tool call — the MCP handler
 * answers it with its own protocol error.
 */
async function invokesProtectedTool(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false;
  try {
    const body: unknown = await request.clone().json();
    const messages = Array.isArray(body) ? body : [body];
    return messages.some((message) => {
      if (typeof message !== "object" || message === null) return false;
      const { method, params } = message as { method?: unknown; params?: { name?: unknown } };
      return method === "tools/call" && typeof params?.name === "string" && isProtectedTool(params.name);
    });
  } catch {
    return false;
  }
}

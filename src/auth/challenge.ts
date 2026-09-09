/*
  The two shapes of "you need to sign in":

  1. Transport level — HTTP 401 with an RFC 6750 / RFC 9728 challenge:
       WWW-Authenticate: Bearer resource_metadata="<PRM URL>", scope="…",
                         error="…", error_description="…"
     MCP clients (Claude connectors, Cursor, mcp-remote, the SDK) read the
     `resource_metadata` URL, discover our authorization server from it,
     run OAuth and retry.

  2. Result level — a normal tools/call result with `isError: true` whose
     `_meta["mcp/www_authenticate"]` carries the same challenge string. This
     is what ChatGPT's per-tool linking UI is documented to key on, and it
     is the only shape available on stdio, where there is no HTTP status.
*/
import { MCP_RESOURCE, OAUTH_SCOPES, PRM_URL } from "./config.js";

export type ChallengeReason = {
  error?: "invalid_token" | "insufficient_scope" | "invalid_request";
  description?: string;
};

/** The `WWW-Authenticate` value; RFC 7235 quoted-string escaping on the free text. */
export function challengeHeader(reason: ChallengeReason = {}): string {
  // Parameter order is free per RFC 7235; this is the order Anthropic's
  // lazy-auth guide shows, kept identical to remove one variable when
  // comparing against their sample.
  const parts: string[] = [];
  if (reason.error) parts.push(`error="${reason.error}"`);
  if (reason.description) parts.push(`error_description="${quote(reason.description)}"`);
  parts.push(`resource_metadata="${PRM_URL}"`, `scope="${OAUTH_SCOPES.join(" ")}"`);
  return `Bearer ${parts.join(", ")}`;
}

export function unauthorizedResponse(reason: ChallengeReason = {}): Response {
  const status = reason.error === "insufficient_scope" ? 403 : 401;
  return new Response(
    JSON.stringify({
      error: reason.error ?? "unauthorized",
      error_description: reason.description ?? `Sign in with LuxAlgo to use this tool (resource ${MCP_RESOURCE}).`,
      resource_metadata: PRM_URL,
    }),
    {
      status,
      headers: {
        "content-type": "application/json",
        "www-authenticate": challengeHeader(reason),
        "cache-control": "no-store",
      },
    },
  );
}

/**
 * Tool result that asks the client to authenticate. `hint` is appended to
 * the human text (e.g. how to sign in from a local install) but kept out of
 * the machine-readable challenge.
 */
export function signInRequiredResult(reason: ChallengeReason = {}, hint?: string) {
  const description = reason.description ?? "Sign in with your LuxAlgo account to use this tool.";
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: hint ? `${description} ${hint}` : description }],
    _meta: {
      "mcp/www_authenticate": [challengeHeader({ error: reason.error ?? "invalid_request", description })],
    },
  };
}

const quote = (text: string): string => text.replace(/[\r\n]+/g, " ").replace(/["\\]/g, "\\$&");

/*
  Vercel Functions entry — the hosted deployment when mcp.luxalgo.com
  lives on Vercel. `vercel.json` rewrites every path to this function and
  mcp-handler routes on the original URL, so clients still connect to
  /mcp (streamable HTTP). Same tool registration as the stdio and plain-Node
  entries (src/entries/hosted.ts); stateless, no Redis needed. mcp-handler 2
  serves MCP 2026-07-28 natively and answers 2025-era clients through the
  SDK's stateless legacy fallback. The function's maxDuration lives in
  vercel.json.

  The request first passes the auth gate (RFC 9728 metadata, bearer
  verification, 401 challenge for anonymous protected calls). A verified
  identity is mounted on `request.auth`, which mcp-handler forwards to the
  SDK as ctx.http.authInfo.
*/
import { createMcpHandler } from "mcp-handler";
import { flushAnalytics } from "../src/platform/analytics.js";
import { SERVER_NAME, SERVER_VERSION, registerHostedTools, withLuxalgoAuth } from "../src/entries/hosted.js";

const mcpHandler = createMcpHandler(
  (server) => registerHostedTools(server),
  // Same identity as the stdio and plain-Node entries (otherwise
  // mcp-handler advertises its own default serverInfo).
  { serverInfo: { name: SERVER_NAME, version: SERVER_VERSION } },
);

const gatedHandler = withLuxalgoAuth(async (request, auth) => {
  if (auth) request.auth = auth;
  return mcpHandler(request);
});

// Serverless functions can freeze before posthog-node's async batch sends,
// so drain the queue at the end of every invocation.
async function handler(request: Request): Promise<Response> {
  try {
    return await gatedHandler(request);
  } finally {
    await flushAnalytics();
  }
}

export { handler as GET, handler as POST, handler as DELETE, handler as OPTIONS, handler as HEAD };

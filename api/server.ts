/*
  Vercel Functions entry — the hosted deployment when mcp.luxalgo.com
  lives on Vercel. `vercel.json` rewrites every path to this function and
  mcp-handler routes on the original URL, so clients still connect to
  /mcp (streamable HTTP). Same registerAllTools() as the stdio and
  plain-Node entries; stateless, no Redis needed. mcp-handler 2 serves MCP
  2026-07-28 natively and answers 2025-era clients through the SDK's
  stateless legacy fallback. The function's maxDuration lives in vercel.json.

  OAuth (see src/lib/auth/): the request first passes the auth gate, which
  serves /.well-known/oauth-protected-resource, verifies any bearer token
  against the LuxAlgo app's JWKS, and refuses anonymous calls to protected
  tools with the RFC 9728 challenge. A verified identity is mounted on
  `request.auth`, which mcp-handler forwards to the SDK as ctx.http.authInfo.
  Keyless tools never notice any of this.
*/
import { createMcpHandler } from "mcp-handler";
import { SERVER_NAME, SERVER_VERSION, registerAllTools } from "../src/lib/register.js";
import { flushAnalytics, instrumentServer } from "../src/lib/analytics.js";
import { withLuxalgoAuth } from "../src/lib/auth/gate.js";

const mcpHandler = createMcpHandler(
  (server) => {
    instrumentServer(server);
    registerAllTools(server);
  },
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

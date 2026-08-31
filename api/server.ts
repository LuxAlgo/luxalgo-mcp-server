/*
  Vercel Functions entry — the hosted deployment when mcp.luxalgo.com
  lives on Vercel. `vercel.json` rewrites every path to this function and
  mcp-handler routes on the original URL, so clients still connect to
  /mcp (streamable HTTP). Same registerAllTools() as the stdio and
  plain-Node entries; stateless, no Redis needed.
*/
import { createMcpHandler } from "mcp-handler";
import { registerAllTools } from "../src/lib/register.js";
import { flushAnalytics, instrumentServer } from "../src/lib/analytics.js";

const mcpHandler = createMcpHandler(
  (server) => {
    instrumentServer(server);
    registerAllTools(server);
  },
  {},
  { maxDuration: 60 },
);

// Serverless functions can freeze before posthog-node's async batch sends,
// so drain the queue at the end of every invocation.
async function handler(request: Request): Promise<Response> {
  try {
    return await mcpHandler(request);
  } finally {
    await flushAnalytics();
  }
}

export { handler as GET, handler as POST, handler as DELETE };

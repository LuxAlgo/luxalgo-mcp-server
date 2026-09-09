/*
  Hosted (Streamable HTTP) entry — what mcp.luxalgo.com runs. Stateless:
  the SDK builds a fresh server per request from the factory below, so the
  process can scale horizontally and restart freely. No secrets, no sessions.
  Speaks MCP 2026-07-28 and still serves 2025-era clients (current Cursor
  builds included) through the SDK's per-request legacy fallback.

  OAuth (see lib/auth/): the auth gate in front of the MCP handler serves
  the RFC 9728 metadata, verifies bearer tokens against the LuxAlgo app's
  JWKS and refuses anonymous calls to protected tools with a 401 challenge;
  the verified identity reaches tools as ctx.http.authInfo.

  Deploy notes: any Node 20+ host works (`node dist/http.js`, PORT env).
  On Vercel, deploy api/server.ts (mcp-handler) instead of this file.
  For local OAuth development point MCP_RESOURCE at this process
  (http://localhost:3333/mcp) and LUXALGO_APP_ORIGIN at a local app.
*/
import { createServer } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { SERVER_NAME, SERVER_VERSION, registerAllTools } from "./lib/register.js";
import { instrumentServer, shutdownAnalytics } from "./lib/analytics.js";
import { withLuxalgoAuth } from "./lib/auth/gate.js";
import { isProtectedResourceMetadataPath } from "./lib/auth/metadata.js";

const PORT = Number(process.env.PORT ?? 3333);

const mcpHandler = createMcpHandler(
  () => {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    instrumentServer(server, (message) => console.error(`[posthog] ${message}`));
    registerAllTools(server);
    return server;
  },
  {
    legacy: "stateless",
    onerror: (error) => console.error("[mcp] request error:", error),
  },
);
// Gate first, then the SDK handler with the verified identity (if any).
const gatedHandler = {
  fetch: withLuxalgoAuth((request, auth) => mcpHandler.fetch(request, auth ? { authInfo: auth } : undefined)),
};
const mcpNodeHandler = toNodeHandler(gatedHandler, {
  onerror: (error) => console.error("[mcp] request failed:", error),
});

const httpServer = createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (pathname !== "/mcp" && !isProtectedResourceMetadataPath(pathname)) {
    res.writeHead(404).end();
    return;
  }
  void mcpNodeHandler(req, res);
});

httpServer.listen(PORT, () => {
  console.log(`LuxAlgo MCP listening on :${PORT}/mcp`);
});

// Drain queued analytics events before the process dies.
if (process.env.POSTHOG_PROJECT_TOKEN) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      httpServer.close();
      void shutdownAnalytics().finally(() => process.exit(0));
    });
  }
}

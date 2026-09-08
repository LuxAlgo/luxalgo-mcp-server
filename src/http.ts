/*
  Hosted (Streamable HTTP) entry — what mcp.luxalgo.com runs. Stateless:
  the SDK builds a fresh server per request from the factory below, so the
  process can scale horizontally and restart freely. No secrets, no sessions.
  Speaks MCP 2026-07-28 and still serves 2025-era clients (current Cursor
  builds included) through the SDK's per-request legacy fallback.

  Deploy notes: any Node 20+ host works (`node dist/http.js`, PORT env).
  On Vercel, deploy api/server.ts (mcp-handler) instead of this file.
*/
import { createServer } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { SERVER_NAME, SERVER_VERSION, registerAllTools } from "./lib/register.js";
import { instrumentServer, shutdownAnalytics } from "./lib/analytics.js";

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
const mcpNodeHandler = toNodeHandler(mcpHandler, {
  onerror: (error) => console.error("[mcp] request failed:", error),
});

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url !== "/mcp") {
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

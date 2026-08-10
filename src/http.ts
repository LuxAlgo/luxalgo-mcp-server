/*
  Hosted (Streamable HTTP) entry — what mcp.luxalgo.com runs. Stateless:
  each request gets a fresh server + transport pair, so the process can
  scale horizontally and restart freely. No secrets, no sessions.

  Deploy notes: any Node 20+ host works (`node dist/http.js`, PORT env).
  On Vercel, wrap the same registerLibraryTools() with their MCP adapter
  instead of this file.
*/
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerLibraryTools } from "./lib/tools.js";

const PORT = Number(process.env.PORT ?? 3333);

const httpServer = createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url !== "/mcp") {
    res.writeHead(404).end();
    return;
  }
  try {
    const server = new McpServer({ name: "luxalgo-library", version: "0.1.0" });
    registerLibraryTools(server);
    const transport = new StreamableHTTPServerTransport({
      // Stateless mode: no session ids, no server-side state between calls.
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("[mcp] request failed:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  }
});

httpServer.listen(PORT, () => {
  console.log(`LuxAlgo Library MCP listening on :${PORT}/mcp`);
});

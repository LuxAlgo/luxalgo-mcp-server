#!/usr/bin/env node
/*
  Local (stdio) entry — what `npx @luxalgo/mcp` runs. Keyless and
  read-only: every tool call goes to LuxAlgo's public library surfaces.
*/
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerLibraryTools } from "./lib/tools.js";

const server = new McpServer({
  name: "luxalgo-library",
  version: "0.1.0",
});

registerLibraryTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

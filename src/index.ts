#!/usr/bin/env node
/*
  Local (stdio) entry — what `npx @luxalgo/mcp` runs. Keyless and
  read-only: every tool call goes to LuxAlgo's public surfaces.
*/
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SERVER_NAME, SERVER_VERSION, registerAllTools } from "./lib/register.js";

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

registerAllTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);

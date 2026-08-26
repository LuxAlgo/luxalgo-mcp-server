/*
  One registration point for every tool the server exposes, shared by the
  stdio, plain-Node HTTP, and Vercel entries. Each LuxAlgo ecosystem area
  contributes its own register function.
*/
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerLibraryTools } from "./tools.js";
import { registerPropfirmTools } from "./propfirm-tools.js";

export const SERVER_NAME = "luxalgo";
export const SERVER_VERSION = "1.1.0";

export function registerAllTools(server: McpServer) {
  registerLibraryTools(server);
  registerPropfirmTools(server);
}

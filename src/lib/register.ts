/*
  One registration point for every tool the server exposes, shared by the
  stdio, plain-Node HTTP, and Vercel entries. Each LuxAlgo ecosystem area
  contributes its own register function.

  Deliberately NOT here: the broker tools (registerBrokerTools). They read
  the user's own broker keys from local env vars, so only the stdio entry
  (src/index.ts) registers them — a hosted process has no business holding
  anyone's broker credentials.
*/
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerLibraryTools } from "./tools.js";
import { registerPropfirmTools } from "./propfirm-tools.js";
import { registerSimTools } from "./sim-tools.js";
import { registerTrackersTools } from "./trackers-tools.js";
import { registerEdgeTools } from "./edge-tools.js";

export const SERVER_NAME = "luxalgo";
export const SERVER_VERSION = "1.3.0";

export function registerAllTools(server: McpServer) {
  registerLibraryTools(server);
  registerPropfirmTools(server);
  registerSimTools(server);
  registerTrackersTools(server);
  // Hosted-safe: reads only the public nightly artifacts the open-source
  // edge-stats repo publishes (derived session statistics — no raw bars,
  // no keys, nothing user-specific).
  registerEdgeTools(server);
}

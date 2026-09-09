/*
  One registration point for every tool the server exposes, shared by the
  stdio, plain-Node HTTP, and Vercel entries. Each LuxAlgo ecosystem area
  contributes its own register function.

  Deliberately NOT here: the broker tools (registerBrokerTools). They read
  the user's own broker keys from local env vars, so only the stdio entry
  (src/index.ts) registers them — a hosted process has no business holding
  anyone's broker credentials.

  Two kinds of tools live here. The majority work for anyone. The protected
  ones (account-tools.ts) need a signed-in LuxAlgo user. Either kind forwards
  the caller's token — the client's verified bearer when hosted, the local
  login store on stdio — on every request it makes to the app, which is where
  entitlements are decided (see auth/access-context.ts). `auth` says where
  that token comes from.

  Registration order matters at both ends: instrumentToolRegistration must
  run before any registerTool (it wraps the callbacks), advertiseSecuritySchemes
  after every one (it wraps tools/list).
*/
import type { McpServer } from "@modelcontextprotocol/server";
import { registerLibraryTools } from "./tools.js";
import { registerPropfirmTools } from "./propfirm-tools.js";
import { registerSimTools } from "./sim-tools.js";
import { registerTrackersTools } from "./trackers-tools.js";
import { registerEdgeTools } from "./edge-tools.js";
import { registerAccountTools } from "./account-tools.js";
import {
  advertiseSecuritySchemes,
  hostedAuthRuntime,
  instrumentToolRegistration,
  type AuthRuntime,
} from "./auth/protected-tools.js";

export const SERVER_NAME = "luxalgo";
export const SERVER_VERSION = "1.4.0";

export type RegisterOptions = {
  /** Where the caller's token comes from. Hosted entries use the default. */
  auth?: AuthRuntime;
  /**
   * Extra registrations to run before tools/list is finalised (the stdio
   * entry adds its broker tools here so they get `securitySchemes` too).
   */
  also?: (server: McpServer) => void;
};

export function registerAllTools(server: McpServer, options: RegisterOptions = {}) {
  const auth = options.auth ?? hostedAuthRuntime;
  instrumentToolRegistration(server, auth);
  registerLibraryTools(server);
  registerPropfirmTools(server);
  registerSimTools(server);
  registerTrackersTools(server);
  // Hosted-safe: reads only the public nightly artifacts the open-source
  // edge-stats repo publishes (derived session statistics — no raw bars,
  // no keys, nothing user-specific).
  registerEdgeTools(server);
  registerAccountTools(server, auth);
  options.also?.(server);
  advertiseSecuritySchemes(server);
}

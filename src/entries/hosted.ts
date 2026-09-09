/*
  What the two hosted entries (Vercel's api/server.ts and the plain-Node
  node-http.ts) share: a per-request, stateless server with the hosted auth
  runtime, and the auth gate in front of it. Hosted means no local-only
  modules (broker tools) — see server/manifest.ts.

  OAuth (see auth/): the gate serves the RFC 9728 metadata, verifies bearer
  tokens against the LuxAlgo app's JWKS and refuses anonymous calls to
  protected tools with a 401 challenge; the verified identity reaches tools
  as ctx.http.authInfo. Keyless tools never notice any of this.
*/
import type { McpServer } from "@modelcontextprotocol/server";
import { createLuxalgoServer, registerLuxalgoTools } from "../server/create-server.js";

export { withLuxalgoAuth } from "../auth/gate.js";
export { isProtectedResourceMetadataPath } from "../auth/metadata.js";
export { SERVER_NAME, SERVER_VERSION } from "../server/version.js";

const log = (message: string) => console.error(message);

/** A fresh, fully registered hosted server — one per request. */
export const createHostedServer = (): McpServer => createLuxalgoServer({ entry: "hosted", log });

/** The same registration onto a server someone else constructed (mcp-handler does). */
export const registerHostedTools = (server: McpServer): void => registerLuxalgoTools(server, { entry: "hosted", log });

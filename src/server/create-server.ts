/*
  One registration point for every tool the server exposes, shared by the
  stdio, plain-Node HTTP, and Vercel entries. The modules come from
  manifest.ts; the entry says two things — where the caller's token comes
  from (`auth`) and whether it is hosted, which decides if local-only
  modules (broker tools reading the user's own keys) are registered at all.

  Two kinds of tools exist. The majority work for anyone. The protected ones
  need a signed-in LuxAlgo user. Either kind forwards the caller's token —
  the client's verified bearer when hosted, the local login store on stdio —
  on every request it makes to the app, which is where entitlements are
  decided (see auth/access-context.ts).

  Registration order matters at both ends: analytics + instrumentToolRegistration
  must run before any registerTool (they wrap the callbacks),
  advertiseSecuritySchemes after every one (it wraps tools/list).
*/
import { McpServer } from "@modelcontextprotocol/server";
import { advertiseSecuritySchemes, instrumentToolRegistration } from "../auth/instrument.js";
import { SECURITY_SCHEMES_ENABLED } from "../auth/config.js";
import { hostedAuthRuntime, type AuthRuntime } from "../auth/runtime.js";
import { instrumentServer } from "../platform/analytics.js";
import { PROTECTED_TOOL_NAMES, TOOL_MODULES } from "./manifest.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

export type ServerOptions = {
  /**
   * "hosted": per-request server behind the HTTP auth gate; local-only
   * modules are skipped. "local": the stdio process on the user's machine.
   */
  entry: "hosted" | "local";
  /** Where the caller's token comes from. Hosted entries use the bearer the gate verified. */
  auth?: AuthRuntime;
  /** Diagnostics sink. Must be stderr-safe on stdio (stdout is the protocol). */
  log?: (message: string) => void;
};

/** Registers every applicable module on an existing server (mcp-handler hands us one). */
export function registerLuxalgoTools(server: McpServer, options: ServerOptions): void {
  const auth = options.auth ?? hostedAuthRuntime;
  // Analytics wrap registerTool too, so they go first. No-op unless POSTHOG_PROJECT_TOKEN is set.
  instrumentServer(server, options.log ? (message) => options.log?.(`[posthog] ${message}`) : undefined);
  instrumentToolRegistration(server, auth);

  const registered = trackRegistrations(server);
  for (const module of TOOL_MODULES) {
    if (module.localOnly && options.entry !== "local") continue;
    const before = registered.size;
    module.register(server, { auth });
    assertModuleManifest(module, [...registered].slice(before));
  }
  if (SECURITY_SCHEMES_ENABLED) advertiseSecuritySchemes(server, PROTECTED_TOOL_NAMES);
}

/** A new, fully registered server with this package's identity. */
export function createLuxalgoServer(options: ServerOptions): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerLuxalgoTools(server, options);
  return server;
}

/** Records tool names as they are registered (after the wrappers above, so every path is seen). */
function trackRegistrations(server: McpServer): Set<string> {
  const names = new Set<string>();
  type AnyRegister = (name: string, ...rest: unknown[]) => unknown;
  const register = server.registerTool.bind(server) as AnyRegister;
  (server as unknown as { registerTool: AnyRegister }).registerTool = (name, ...rest) => {
    names.add(name);
    return register(name, ...rest);
  };
  return names;
}

/**
 * The manifest is what the HTTP gate and the securitySchemes hint read, so it
 * has to be true: a module must register exactly the tools it declares, and
 * every protected tool must be declared among them.
 */
function assertModuleManifest(module: { id: string; tools: readonly string[]; protectedTools?: readonly string[] }, actual: string[]): void {
  const declared = [...module.tools].sort();
  const seen = [...actual].sort();
  if (declared.join(",") !== seen.join(",")) {
    throw new Error(
      `tool module "${module.id}" declares [${declared.join(", ")}] but registered [${seen.join(", ")}] — update its index.ts`,
    );
  }
  for (const name of module.protectedTools ?? []) {
    if (!module.tools.includes(name)) {
      throw new Error(`tool module "${module.id}": protected tool "${name}" is not in its tools list`);
    }
  }
}

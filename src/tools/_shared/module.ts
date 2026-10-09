/*
  The contract every tool domain exports from its index.ts, and the one
  thing server/manifest.ts lists. Declarative on purpose: the two facts the
  rest of the server needs about a tool BEFORE any McpServer exists —
  "is it protected?" (the HTTP gate refuses anonymous calls to those with a
  401 before the request reaches the SDK) and "is it local-only?" (broker
  tools hold the user's keys and must never register on a hosted entry) —
  live here next to the registration code, so they cannot drift from it.
*/
import type { McpServer } from "@modelcontextprotocol/server";
import type { AuthRuntime } from "../../auth/runtime.js";
import type { Toolset } from "../../auth/surface.js";

export type ToolModuleContext = {
  /** Where the caller's token comes from on this entry (hosted bearer or local store). */
  auth: AuthRuntime;
  /** Which variant of the tools to register — "directory" on the ChatGPT and Claude addresses (auth/surface.ts). */
  toolset: Toolset;
};

export type ToolModule = {
  /** Domain id, for logs and the manifest (e.g. "library"). */
  id: string;
  /** Every tool name this module registers, as they appear in tools/list. */
  tools: readonly string[];
  /**
   * Tools among `tools` that need a signed-in LuxAlgo user. Registration
   * must go through registerProtectedTool for each of these.
   */
  protectedTools?: readonly string[];
  /**
   * True for modules that may only run on the stdio entry (credentials from
   * the user's own environment). createLuxalgoServer skips them when hosted.
   */
  localOnly?: boolean;
  /** Tools among `tools` this module leaves out of the "directory" toolset. */
  omitFromDirectory?: readonly string[];
  register: (server: McpServer, ctx: ToolModuleContext) => void;
};

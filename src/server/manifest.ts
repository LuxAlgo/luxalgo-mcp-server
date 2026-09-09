/*
  The list of tool domains this server exposes, and the two derived facts the
  rest of the server reads before any McpServer exists:

    PROTECTED_TOOL_NAMES  tools needing a signed-in user — the HTTP gate
                          refuses anonymous calls to these with a 401 before
                          the request reaches the SDK (hosted entries build
                          the server per request, so this cannot be learned
                          at registration time or a cold process would wave
                          the first protected call through);
    LOCAL_ONLY_MODULES    modules that must never register when hosted.

  To add a domain: create tools/<domain>/index.ts exporting a ToolModule and
  list it here. createLuxalgoServer verifies at registration that the module
  registers exactly the tools it declares, so the manifest cannot drift.
*/
import type { ToolModule } from "../tools/_shared/module.js";
import { libraryModule } from "../tools/library/index.js";
import { propfirmsModule } from "../tools/propfirms/index.js";
import { trackersModule } from "../tools/trackers/index.js";
import { edgeModule } from "../tools/edge/index.js";
import { accountModule } from "../tools/account/index.js";
import { brokerModule } from "../tools/broker/index.js";

/** Registration order is tools/list order. */
export const TOOL_MODULES: readonly ToolModule[] = [
  libraryModule,
  propfirmsModule,
  trackersModule,
  edgeModule,
  accountModule,
  brokerModule,
];

export const PROTECTED_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_MODULES.flatMap((module) => module.protectedTools ?? []),
);

export function isProtectedTool(name: string): boolean {
  return PROTECTED_TOOL_NAMES.has(name);
}

export const LOCAL_ONLY_MODULES: readonly ToolModule[] = TOOL_MODULES.filter((module) => module.localOnly);

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
import { journalModule } from "../tools/journal/index.js";
import { brokerModule } from "../tools/broker/index.js";
import { chartModule, chartPeekModule, chartToolsEnabled } from "../tools/chart/index.js";
import { accountToolsEnabled } from "../tools/_shared/member.js";
import { watchlistsModule } from "../tools/watchlists/index.js";
import { layoutsModule } from "../tools/layouts/index.js";
import { alertsModule } from "../tools/alerts/index.js";

/** Registration order is tools/list order. */
export const TOOL_MODULES: readonly ToolModule[] = [
  libraryModule,
  propfirmsModule,
  trackersModule,
  edgeModule,
  accountModule,
  journalModule,
  brokerModule,
  // Spike: live charts (MCP Apps) stay off unless LUXALGO_CHART_TOOLS=on or VERCEL_ENV=preview.
  ...(chartToolsEnabled() ? [chartModule] : []),
  // The member's watchlists, saved layouts, alerts and a picture of their open Vela chart: off unless LUXALGO_ACCOUNT_TOOLS=on or VERCEL_ENV=preview
  // (the app routes they call are not in production yet), and never on the Claude address (_shared/member.ts).
  ...(accountToolsEnabled() ? [watchlistsModule, layoutsModule, alertsModule, chartPeekModule] : []),
];

export const PROTECTED_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_MODULES.flatMap((module) => module.protectedTools ?? []),
);

export function isProtectedTool(name: string): boolean {
  return PROTECTED_TOOL_NAMES.has(name);
}

export const LOCAL_ONLY_MODULES: readonly ToolModule[] = TOOL_MODULES.filter((module) => module.localOnly);

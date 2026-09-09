/*
  Prop-firm challenge simulation tools, backed by the open-source
  prop-firm-sim engine (github.com/LuxAlgo/prop-firm-sim) via its published
  npm packages. The Monte Carlo engine runs locally in this process; the only
  network is the public prop-firm directory (fetched and cached by the sim
  package, LUXALGO_APP_ORIGIN-aware). Results are deterministic under seed.

    simulation/package-tools.ts      six tools re-registered from
                                     @luxalgo/prop-firm-sim-mcp under the
                                     propfirms_ naming convention
    simulation/pass-rates.ts         propfirms_pass_rates
    simulation/validate-strategy.ts  propfirms_validate_strategy
*/
import type { McpServer } from "@modelcontextprotocol/server";
import { PACKAGE_TOOL_NAMES, registerPackageSimTools } from "./simulation/package-tools.js";
import { registerPassRatesTool } from "./simulation/pass-rates.js";
import { registerValidateStrategyTool } from "./simulation/validate-strategy.js";

export const SIMULATION_TOOL_NAMES: readonly string[] = [
  ...PACKAGE_TOOL_NAMES,
  "propfirms_pass_rates",
  "propfirms_validate_strategy",
];

export function registerSimTools(server: McpServer): void {
  registerPackageSimTools(server);
  registerPassRatesTool(server);
  registerValidateStrategyTool(server);
}

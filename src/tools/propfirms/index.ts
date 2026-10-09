import type { ToolModule } from "../_shared/module.js";
import { registerPropfirmTools } from "./directory-tools.js";
import { SIMULATION_TOOL_NAMES, registerSimTools } from "./simulation-tools.js";

/**
 * Prop firms: the directory (firms, challenges, live offers — what exists
 * and on what terms) and the Monte Carlo simulator (what the odds are).
 * Keyless; the engine runs in-process.
 */
export const propfirmsModule: ToolModule = {
  id: "propfirms",
  tools: [
    "propfirms_search",
    "propfirms_search_challenges",
    "propfirms_search_offers",
    "propfirms_get",
    ...SIMULATION_TOOL_NAMES,
  ],
  // Offers are promo codes and affiliate links (directory-tools.ts).
  omitFromOpenAi: ["propfirms_search_offers"],
  register: (server, { toolset }) => {
    registerPropfirmTools(server, toolset);
    registerSimTools(server, toolset);
  },
};

import type { ToolModule } from "../_shared/module.js";
import { registerQuantTools } from "./tools.js";

const QUANT_TOOLS = ["quant_generate_pine", "quant_validate_pine"] as const;

/**
 * Quant, our coding agent: Pine Script® written and checked for the signed-in
 * user, on their plan's usage. Both app routes need a user, so both tools are protected.
 */
export const quantModule: ToolModule = {
  id: "quant",
  tools: QUANT_TOOLS,
  protectedTools: QUANT_TOOLS,
  register: (server, { auth }) => registerQuantTools(server, auth),
};

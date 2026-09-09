import type { ToolModule } from "../_shared/module.js";
import { registerEdgeTools } from "./tools.js";

/** Edge Stats: hosted session statistics from the open-source edge-stats engine. Keyless. */
export const edgeModule: ToolModule = {
  id: "edge",
  tools: ["edge_symbols", "edge_presets", "edge_report"],
  register: (server) => registerEdgeTools(server),
};

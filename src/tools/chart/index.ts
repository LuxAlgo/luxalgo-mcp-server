import type { ToolModule } from "../_shared/module.js";
import { registerChartTools } from "./tools.js";

/**
 * Live Vela charts in the chat (MCP Apps). SPIKE: server/manifest.ts lists
 * this module only when LUXALGO_CHART_TOOLS=on or on a Vercel preview
 * deployment (VERCEL_ENV=preview, Vercel's own system variable), so
 * production and the ChatGPT and Claude directory surfaces are unchanged.
 * Keyless.
 */
export const chartModule: ToolModule = {
  id: "chart",
  tools: ["chart_open", "chart_command", "chart_sync"],
  register: (server) => registerChartTools(server),
};

/** Never true on Vercel production unless LUXALGO_CHART_TOOLS=on is set there explicitly. */
export const chartToolsEnabled = (): boolean =>
  process.env.LUXALGO_CHART_TOOLS === "on" || process.env.VERCEL_ENV === "preview";

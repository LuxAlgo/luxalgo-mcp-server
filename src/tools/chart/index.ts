import type { ToolModule } from "../_shared/module.js";
import { answersFrozen } from "../_shared/surface.js";
import { registerChartTools } from "./tools.js";
import { memberToolModule } from "../_shared/member.js";
import { registerChartPeekTools } from "./peek.js";

const CHART_TOOLS = ["chart_open", "chart_command", "chart_sync"] as const;

/**
 * Live Vela charts in the chat (MCP Apps). SPIKE: server/manifest.ts lists
 * this module only when LUXALGO_CHART_TOOLS=on or on a Vercel preview
 * deployment (VERCEL_ENV=preview, Vercel's own system variable), so
 * production is unchanged. Keyless.
 *
 * Never on the Claude address, flag or not: it is under directory review with
 * exactly the tools it was submitted with (tools/_shared/surface.ts). Same
 * shape as the member modules (tools/_shared/member.ts): `register` returns
 * early there, so neither the tools nor the ui://vela/chart resource exist on
 * that address, and `omitFromDirectory` (a getter, read at registration inside
 * the request's surface) names all three there only, which is what the startup
 * manifest check compares against. The standard address, the ChatGPT address
 * and stdio get them all.
 */
export const chartModule: ToolModule = {
  id: "chart",
  tools: CHART_TOOLS,
  get omitFromDirectory() {
    return answersFrozen() ? CHART_TOOLS : [];
  },
  register: (server) => {
    if (answersFrozen()) return;
    registerChartTools(server);
  },
};

/** Never true on Vercel production unless LUXALGO_CHART_TOOLS=on is set there explicitly. */
export const chartToolsEnabled = (): boolean =>
  process.env.LUXALGO_CHART_TOOLS === "on" || process.env.VERCEL_ENV === "preview";

/**
 * chart_peek: a picture of the chart the signed-in member has open in Vela
 * (./peek.ts). A member tool, not part of the live chart spike: protected,
 * on with the account tools (LUXALGO_ACCOUNT_TOOLS=on or a Vercel preview,
 * server/manifest.ts), and never on the Claude address (_shared/member.ts).
 */
export const chartPeekModule = memberToolModule("chart-peek", ["chart_peek"], registerChartPeekTools);

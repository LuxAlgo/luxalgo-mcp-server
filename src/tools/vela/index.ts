import { memberToolModule } from "../_shared/member.js";
import { registerVelaChartTools } from "./tools.js";

export const VELA_CHART_TOOLS = ["vela_read_chart", "vela_set_chart", "vela_draw_on_chart", "vela_remove_drawings"] as const;

/**
 * The chart the signed-in member has open in Vela, read and changed by their
 * AI assistant: its market, timeframe, look and layout, and drawings
 * (./tools.ts). Protected member tools: off unless
 * LUXALGO_CHART_CONTROL_TOOLS=on or a Vercel preview (server/manifest.ts,
 * _shared/member.ts), and never on the Claude address.
 */
export const velaChartModule = memberToolModule("vela-chart", VELA_CHART_TOOLS, registerVelaChartTools);

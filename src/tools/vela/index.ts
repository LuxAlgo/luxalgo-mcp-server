import type { ToolModule } from "../_shared/module.js";
import { chartControlOnChatGpt } from "../_shared/member.js";
import { answersFrozen, onChatGptAddress } from "../_shared/surface.js";
import { registerVelaChartTools } from "./tools.js";

export const VELA_CHART_TOOLS = [
  "vela_read_chart",
  "vela_set_chart",
  "vela_mark_up_chart",
  "vela_draw_on_chart",
  "vela_remove_drawings",
] as const;

/** Never on the Claude address; on the ChatGPT address only where asked for by name (_shared/member.ts). */
const leftOutHere = (): boolean => answersFrozen() || (onChatGptAddress() && !chartControlOnChatGpt());

/**
 * The chart the signed-in member has open in Vela, read and changed by their
 * AI assistant: its market, timeframe, look and layout, a pro's markup found
 * on its own candles, and drawings (./tools.ts). Protected member tools:
 * listed when chartControlToolsEnabled (server/manifest.ts, _shared/member.ts).
 *
 * The same shape as the member modules (_shared/member.ts): where they are
 * left out, `register` returns early and `omitFromDirectory` (a getter, read
 * at registration inside the request's surface) names all five, which is
 * what the startup manifest check compares against.
 */
export const velaChartModule: ToolModule = {
  id: "vela-chart",
  tools: VELA_CHART_TOOLS,
  protectedTools: VELA_CHART_TOOLS,
  get omitFromDirectory() {
    return leftOutHere() ? VELA_CHART_TOOLS : [];
  },
  register: (server, { auth }) => {
    if (leftOutHere()) return;
    registerVelaChartTools(server, auth);
  },
};
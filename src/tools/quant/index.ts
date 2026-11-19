import { memberToolModule } from "../_shared/member.js";
import { registerQuantTools } from "./tools.js";

/**
 * Quant, our coding agent, for the signed-in member's AI assistant: write and
 * check Pine Script® (a script that passes is kept in the member's account),
 * find the member's saved scripts, plan, start, stop and follow backtest
 * loops, and read the strategies they found with their backtests. Generating, planning and a running loop use the
 * member's Quant usage, which the LuxAlgo app meters. Off unless
 * LUXALGO_QUANT_TOOLS=on (or a Vercel preview), and never on the Claude
 * address (server/manifest.ts, _shared/member.ts).
 */
export const quantModule = memberToolModule(
  "quant",
  [
    "quant_generate_pine_script",
    "quant_validate_pine_script",
    "quant_search_user_scripts",
    "get_user_script",
    "quant_plan_backtest_loop",
    "quant_start_backtest_loop",
    "quant_stop_backtest_loop",
    "quant_list_backtest_loops",
    "quant_get_backtest_loop_info",
    "quant_get_backtest_loop_strategy",
  ],
  registerQuantTools,
);

import { memberToolModule } from "../_shared/member.js";
import { registerPaperTools } from "./tools.js";

/**
 * Paper Trading by LuxAlgo for the signed-in member: read the paper accounts,
 * propose an order, a close or a cancel, and place it on the member's yes with
 * the proposal's confirmation token. Simulated money only. Off unless
 * LUXALGO_PAPER_TOOLS=on (or a Vercel preview), and never on the Claude
 * address (server/manifest.ts, _shared/member.ts).
 */
export const paperModule = memberToolModule(
  "paper",
  ["paper_account", "paper_propose_order", "paper_close_position", "paper_cancel_order", "paper_place_order"],
  registerPaperTools,
);

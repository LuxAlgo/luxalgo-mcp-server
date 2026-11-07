import { memberToolModule } from "../_shared/member.js";
import { registerWatchlistTools } from "./tools.js";

/**
 * The signed-in member's watchlists. Off unless the account tools are switched
 * on (server/manifest.ts, _shared/member.ts), and never on the Claude address.
 */
export const watchlistsModule = memberToolModule(
  "watchlists",
  ["watchlists_list", "watchlists_create", "watchlists_add_symbols", "watchlists_remove_symbols"],
  registerWatchlistTools,
);

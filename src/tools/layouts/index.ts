import { memberToolModule } from "../_shared/member.js";
import { registerLayoutTools } from "./tools.js";

/**
 * The signed-in member's saved Vela layouts, read only. Off unless the account
 * tools are switched on (server/manifest.ts, _shared/member.ts), and never on
 * the Claude address.
 */
export const layoutsModule = memberToolModule("layouts", ["layouts_list"], registerLayoutTools);

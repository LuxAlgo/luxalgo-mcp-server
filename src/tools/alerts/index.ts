import { memberToolModule } from "../_shared/member.js";
import { registerAlertTools } from "./tools.js";

/**
 * The signed-in member's LuxAlgo Alerts (Price Alerts and Custom Alerts). Off
 * unless the account tools are switched on (server/manifest.ts,
 * _shared/member.ts), and never on the Claude address.
 */
export const alertsModule = memberToolModule(
  "alerts",
  ["alerts_list", "alerts_create_price", "alerts_create_custom", "alerts_pause", "alerts_resume", "alerts_history"],
  registerAlertTools,
);

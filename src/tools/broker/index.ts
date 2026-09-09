import type { ToolModule } from "../_shared/module.js";
import { registerBrokerTools } from "./tools.js";

/**
 * Broker portfolio access over @luxalgo/broker-sdk with the user's own keys
 * from BROKERS_* env vars. LOCAL ONLY — a hosted process has no business
 * holding anyone's broker credentials, so createLuxalgoServer never
 * registers this module when hosted.
 */
export const brokerModule: ToolModule = {
  id: "broker",
  tools: ["broker_setup", "broker_accounts", "broker_positions", "broker_trades", "broker_stats", "broker_refresh"],
  localOnly: true,
  register: (server) => registerBrokerTools(server),
};

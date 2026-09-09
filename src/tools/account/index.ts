import type { ToolModule } from "../_shared/module.js";
import { registerAccountTools } from "./tools.js";

/** The signed-in user's LuxAlgo account. Protected: needs OAuth sign-in on every entry. */
export const accountModule: ToolModule = {
  id: "account",
  tools: ["luxalgo_account"],
  protectedTools: ["luxalgo_account"],
  register: (server, { auth }) => registerAccountTools(server, auth),
};

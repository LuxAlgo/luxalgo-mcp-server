/*
  What the member-account tool domains (watchlists, layouts, alerts, and the
  picture of the member's open Vela chart, chart_peek) share:
  the switch that turns them on, and the module shape that keeps them off the
  Claude address.

  The switch: the app routes these tools call reach production with the
  app's next release, so they register only with LUXALGO_ACCOUNT_TOOLS=on or
  on a Vercel preview deployment (VERCEL_ENV=preview), like the chart tools.
  Production is unchanged until the flag is set there.

  The Claude address is under directory review with exactly the tools it was
  submitted with (tools/_shared/surface.ts), so these modules register
  nothing there: `register` returns early and `omitFromDirectory` names every
  tool on that address only, which is what the startup manifest check
  compares against. The standard address, the ChatGPT address and stdio get
  them all.
*/
import type { McpServer } from "@modelcontextprotocol/server";
import type { AuthRuntime } from "../../auth/runtime.js";
import type { ToolModule } from "./module.js";
import { answersFrozen } from "./surface.js";

/** Never true on Vercel production unless LUXALGO_ACCOUNT_TOOLS=on is set there explicitly. */
export const accountToolsEnabled = (): boolean =>
  process.env.LUXALGO_ACCOUNT_TOOLS === "on" || process.env.VERCEL_ENV === "preview";

/**
 * A domain of the member's own data: every tool needs a signed-in member
 * (the app routes answer 401 anonymously), so every tool is protected.
 */
export function memberToolModule(
  id: string,
  tools: readonly string[],
  register: (server: McpServer, auth: AuthRuntime) => void,
): ToolModule {
  return {
    id,
    tools,
    protectedTools: tools,
    // Read at registration, inside the request's surface: all of them on the Claude address, none elsewhere.
    get omitFromDirectory() {
      return answersFrozen() ? tools : [];
    },
    register: (server, { auth }) => {
      if (answersFrozen()) return;
      register(server, auth);
    },
  };
}

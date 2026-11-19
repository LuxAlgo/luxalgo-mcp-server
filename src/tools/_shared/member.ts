/*
  What the member-account tool domains (watchlists, layouts, alerts, and the
  picture of the member's open Vela chart, chart_peek) share:
  the switch that turns them on, and the module shape that keeps them off the
  Claude address.

  The switch: the app routes these tools call reach production with the
  app's next release, so they register only with LUXALGO_ACCOUNT_TOOLS=on or
  on a Vercel preview deployment (VERCEL_ENV=preview), like the chart tools.
  Production is unchanged until the flag is set there. The alerts tools also
  need their own switch (alertToolsEnabled below).

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
 * The alerts tools' own switch, on top of the account tools' one: LuxAlgo
 * Alerts are not open to every member yet, so the alerts tools stay off in
 * production until they are. Never true on Vercel production unless
 * LUXALGO_ALERT_TOOLS=on is set there explicitly.
 */
export const alertToolsEnabled = (): boolean =>
  process.env.LUXALGO_ALERT_TOOLS === "on" || process.env.VERCEL_ENV === "preview";

/**
 * Paper Trading by LuxAlgo for the member's AI assistant (tools/paper): its own
 * switch, so it can go out after the account tools. Never true on Vercel
 * production unless LUXALGO_PAPER_TOOLS=on is set there explicitly.
 */
export const paperToolsEnabled = (): boolean =>
  process.env.LUXALGO_PAPER_TOOLS === "on" || process.env.VERCEL_ENV === "preview";

/**
 * Quant for the member's AI assistant (tools/quant): Pine Script® generation
 * and linting, the member's scripts and their backtest loops. Its own switch:
 * three of its tools spend the member's Quant usage.
 *
 * Live on the hosted addresses since 2026-11-19: on for every Vercel
 * deployment, production included, and LUXALGO_QUANT_TOOLS=off there switches
 * it off again (set it and redeploy). Anywhere else (stdio, a self-hosted
 * server, the tests) it still needs LUXALGO_QUANT_TOOLS=on. The app's own
 * switch is its PostHog flag `agent-quant`, which takes effect within a
 * minute and without a deploy: turn that off first when something is wrong.
 */
export const quantToolsEnabled = (): boolean => {
  const asked = process.env.LUXALGO_QUANT_TOOLS;
  if (asked === "off") return false;
  return asked === "on" || process.env.VERCEL_ENV === "preview" || process.env.VERCEL_ENV === "production";
};

/**
 * The member's open Vela chart, read and changed by their AI assistant
 * (tools/vela): its market, timeframe, look and layout, a pro's markup and
 * drawings. Its own switch, since it changes what the member sees in their
 * browser.
 *
 * On for every Vercel deployment, production included, and
 * LUXALGO_CHART_CONTROL_TOOLS=off there switches it off again (set it and
 * redeploy). Anywhere else (stdio, a self-hosted server, the tests) it needs
 * LUXALGO_CHART_CONTROL_TOOLS=on. The app's own switch is its PostHog flag
 * `agent-chart-control`, which decides member by member and takes effect
 * within a minute and without a deploy: while it is off for a member the
 * tools tell them it is not available yet. Turn that off first when
 * something is wrong.
 */
export const chartControlToolsEnabled = (): boolean => {
  const asked = process.env.LUXALGO_CHART_CONTROL_TOOLS;
  if (asked === "off") return false;
  return asked === "on" || process.env.VERCEL_ENV === "preview" || process.env.VERCEL_ENV === "production";
};

/**
 * Whether those tools are also listed on the ChatGPT address. Not by default
 * in production: that address is the one OpenAI's plugin directory reviewed,
 * and the app's flag is not open to every member yet, so it would list seven
 * tools that tell most people they are not available. Listed there with
 * LUXALGO_CHART_CONTROL_TOOLS=on, and on a Vercel preview.
 */
export const chartControlOnChatGpt = (): boolean =>
  process.env.LUXALGO_CHART_CONTROL_TOOLS === "on" || process.env.VERCEL_ENV === "preview";

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

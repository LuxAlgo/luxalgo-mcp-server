/* Tool surface: tools/list matches the documented set per entry, every tool advertises securitySchemes, serverInfo matches package.json, instructions point at Vela. */

import { readFile } from "node:fs/promises";

/** Every protected tool (module `protectedTools`), in tools/list order. */
export const PROTECTED = [
  "luxalgo_account",
  "journal_list_accounts",
  "journal_overview",
  "journal_calendar",
  "journal_breakdown",
  "journal_list_trades",
  "journal_get_trade",
  "journal_get_day",
  "journal_list_tags",
  "journal_search_notes",
  "journal_add_trade",
  "journal_update_trade",
  "journal_write_note",
  "journal_update_note",
];

/**
 * The member's watchlists, saved layouts and the picture of their open Vela
 * chart (chart_peek): protected, and opt-in (LUXALGO_ACCOUNT_TOOLS=on or a
 * Vercel preview), so listed all or none. Never on the Claude address
 * (test/smoke/account-tools.mjs).
 */
export const MEMBER_PROTECTED = [
  "watchlists_list",
  "watchlists_create",
  "watchlists_add_symbols",
  "watchlists_remove_symbols",
  "layouts_list",
  "chart_peek",
];

/**
 * The member's alerts: protected, and listed only when the account tools are
 * on AND their own switch is (LUXALGO_ALERT_TOOLS=on or a Vercel preview).
 */
export const ALERTS_PROTECTED = [
  "alerts_list",
  "alerts_create_price",
  "alerts_create_custom",
  "alerts_pause",
  "alerts_resume",
  "alerts_history",
];

/** Every account tool with both switches on, in tools/list order. */
export const ACCOUNT_PROTECTED = [...MEMBER_PROTECTED.slice(0, 5), ...ALERTS_PROTECTED, "chart_peek"];

/** Market Trackers: public, on the standard address, stdio and the Claude address; never on the ChatGPT address. */
export const TRACKERS = ["trackers_datasets", "trackers_query", "trackers_latest", "trackers_ticker"];

export async function run({ client, check, callJson, callStructured, httpUrl, rawToolsList }) {
  // tools/list
  const { tools } = await client.listTools();
  const expected = [
    "library_search",
    "library_get_concept",
    "library_get_indicator",
    "library_get_source_code",
    "library_list_concepts",
    "library_list_indicators",
    "library_list_families",
    "library_get_family",
    "propfirms_search",
    "propfirms_get",
    "propfirms_search_challenges",
    "propfirms_search_offers",
    "propfirms_list_simulatable",
    "propfirms_challenge_rules",
    "propfirms_simulate",
    "propfirms_optimal_risk",
    "propfirms_compare",
    "propfirms_simulate_trades",
    "propfirms_pass_rates",
    "propfirms_validate_strategy",
    ...TRACKERS,
    "edge_symbols",
    "edge_presets",
    "edge_report",
    ...PROTECTED, // need a LuxAlgo sign-in (OAuth); checked below
  ];
  // Broker tools are local-only: present over stdio, absent on the hosted entries.
  const brokerExpected = [
    "broker_setup",
    "broker_accounts",
    "broker_positions",
    "broker_trades",
    "broker_stats",
    "broker_refresh",
  ];
  // The live chart tools are opt-in (LUXALGO_CHART_TOOLS=on or a Vercel preview): all three or none.
  const chartExpected = ["chart_open", "chart_command", "chart_sync"];
  const chartOn = tools.some((t) => chartExpected.includes(t.name)); // chart_peek is an account tool, not one of these
  // Over stdio this run's switches decide (the runner passes them through); over HTTP the deployment's, read from its list.
  const accountOn = httpUrl ? tools.some((t) => MEMBER_PROTECTED.includes(t.name)) : process.env.LUXALGO_ACCOUNT_TOOLS === "on";
  const alertsOn = accountOn && (httpUrl ? tools.some((t) => ALERTS_PROTECTED.includes(t.name)) : process.env.LUXALGO_ALERT_TOOLS === "on");
  const accountExpected = [...(accountOn ? MEMBER_PROTECTED : []), ...(alertsOn ? ALERTS_PROTECTED : [])];
  const protectedAll = [...PROTECTED, ...accountExpected];
  const expectedAll = [...expected, ...(httpUrl ? [] : brokerExpected), ...(chartOn ? chartExpected : []), ...accountExpected];
  const names = tools.map((t) => t.name).sort();
  check(
    `tools/list exposes exactly the ${expectedAll.length} ${httpUrl ? "hosted" : "stdio"} tools${chartOn ? " (chart tools on)" : ""}${accountOn ? " (account tools on)" : ""}${alertsOn ? " (alerts on)" : ""}`,
    names.length === expectedAll.length && expectedAll.slice().sort().every((n, i) => names[i] === n),
    names.join(", "),
  );
  if (!alertsOn) {
    check(
      `with the alert switch off${accountOn ? " (account tools on)" : ""}, no alerts tool is listed`,
      names.every((n) => !n.startsWith("alerts_")),
      names.filter((n) => n.startsWith("alerts_")).join(", ") || "none",
    );
  }
  check(
    httpUrl ? "hosted entry exposes no broker tools" : "stdio entry exposes all 6 broker tools",
    httpUrl
      ? names.every((n) => !n.startsWith("broker_"))
      : brokerExpected.every((n) => names.includes(n)),
    names.filter((n) => n.startsWith("broker_")).join(", ") || "none",
  );

  // OAuth advertisement — every tool declares its auth policy (securitySchemes,
  // OpenAI's MCP extension): public tools `noauth`, protected ones `oauth2`.
  // The SDK client strips fields it does not know, so read the raw wire.
  // (This is the standard host and stdio; the Claude host leaves the field
  // out — checked in the discovery suite.)
  const rawTools = await rawToolsList();
  const schemesOf = (name) => rawTools.find((t) => t.name === name)?.securitySchemes ?? [];
  const isProtected = new Set(protectedAll);
  check(
    "every public tool advertises securitySchemes: [noauth] on the wire",
    rawTools.length === expectedAll.length &&
      rawTools
        .filter((t) => !isProtected.has(t.name))
        .every((t) => Array.isArray(t.securitySchemes) && t.securitySchemes.some((s) => s.type === "noauth")),
    `${rawTools.length} tools; library_search → ${JSON.stringify(schemesOf("library_search"))}`,
  );
  const oauth = (name) =>
    schemesOf(name).some((s) => s.type === "oauth2" && Array.isArray(s.scopes) && s.scopes.includes("openid"));
  check(
    `all ${protectedAll.length} protected tools advertise securitySchemes: [oauth2 + scopes] on the wire`,
    protectedAll.every(oauth),
    protectedAll.filter((name) => !oauth(name)).join(", ") || `luxalgo_account → ${JSON.stringify(schemesOf("luxalgo_account"))}`,
  );

  // serverInfo — the hardcoded SERVER_VERSION (src/server/version.ts) must track package.json.
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const serverInfo = client.getServerVersion();
  check(
    `serverInfo is luxalgo@${pkg.version} (package.json)`,
    serverInfo?.name === "luxalgo" && serverInfo?.version === pkg.version,
    `${serverInfo?.name}@${serverInfo?.version}`,
  );

  // instructions — agents learn on connect where a chart link takes the user.
  const instructions = client.getInstructions() ?? "";
  check(
    "on connect, the server tells agents that Vela is LuxAlgo's charts and to send users to chart_url",
    instructions.includes("Vela") && instructions.includes("https://vela.luxalgo.com/chart") && instructions.includes("chart_url"),
    instructions ? `${instructions.length} chars` : "no instructions",
  );
}

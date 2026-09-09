/* Tool surface: tools/list matches the documented set per entry, every tool advertises securitySchemes, serverInfo matches package.json. */

import { readFile } from "node:fs/promises";

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
    "library_list_tags",
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
    "trackers_datasets",
    "trackers_query",
    "trackers_latest",
    "trackers_ticker",
    "edge_symbols",
    "edge_presets",
    "edge_report",
    "luxalgo_account", // protected — needs a LuxAlgo sign-in (OAuth); checked below
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
  const expectedAll = httpUrl ? expected : [...expected, ...brokerExpected];
  const names = tools.map((t) => t.name).sort();
  check(
    `tools/list exposes exactly the ${expectedAll.length} ${httpUrl ? "hosted" : "stdio"} tools`,
    names.length === expectedAll.length && expectedAll.slice().sort().every((n, i) => names[i] === n),
    names.join(", "),
  );
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
  const rawTools = await rawToolsList();
  const schemesOf = (name) => rawTools.find((t) => t.name === name)?.securitySchemes ?? [];
  check(
    "every public tool advertises securitySchemes: [noauth] on the wire",
    rawTools.length === expectedAll.length &&
      rawTools
        .filter((t) => t.name !== "luxalgo_account")
        .every((t) => Array.isArray(t.securitySchemes) && t.securitySchemes.some((s) => s.type === "noauth")),
    `${rawTools.length} tools; library_search → ${JSON.stringify(schemesOf("library_search"))}`,
  );
  check(
    "luxalgo_account advertises securitySchemes: [oauth2 + scopes] on the wire",
    schemesOf("luxalgo_account").some((s) => s.type === "oauth2" && Array.isArray(s.scopes) && s.scopes.includes("openid")),
    JSON.stringify(schemesOf("luxalgo_account")),
  );

  // serverInfo — the hardcoded SERVER_VERSION (src/server/version.ts) must track package.json.
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const serverInfo = client.getServerVersion();
  check(
    `serverInfo is luxalgo@${pkg.version} (package.json)`,
    serverInfo?.name === "luxalgo" && serverInfo?.version === pkg.version,
    `${serverInfo?.name}@${serverInfo?.version}`,
  );
}

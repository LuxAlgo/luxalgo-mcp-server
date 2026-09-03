/*
  End-to-end smoke test: connects a real MCP client to the built server
  over stdio, lists tools, and calls all of them against the live LuxAlgo
  endpoints. Pass --http <url> to test a running streamable-HTTP server
  instead. Exits non-zero on any failure.
*/
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const httpUrl = process.argv.includes("--http")
  ? process.argv[process.argv.indexOf("--http") + 1]
  : null;

let failures = 0;
function check(label, condition, detail = "") {
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failures++;
  console.log(`${status}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function callJson(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  return { isError: result.isError === true, payload: JSON.parse(text) };
}

/** For the simulator tools, which return human text + structuredContent. */
async function callStructured(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: result.isError === true,
    data: result.structuredContent ?? {},
    text: result.content?.[0]?.text ?? "",
  };
}

const client = new Client({ name: "smoke", version: "0.0.0" });
const transport = httpUrl
  ? new StreamableHTTPClientTransport(new URL(httpUrl))
  : new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
await client.connect(transport);
console.log(`Connected via ${httpUrl ? `HTTP (${httpUrl})` : "stdio"}\n`);

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

if (!httpUrl) {
  // No BROKERS_* env in this run: setup lists everything unconfigured and
  // the data tools answer cleanly with empty results, never errors.
  const setup = await callJson(client, "broker_setup", {});
  check(
    "broker_setup lists 16+ brokers, none configured, values never shown",
    !setup.isError &&
      setup.payload.length >= 16 &&
      setup.payload.every((b) => b.configured === false && b.readOnlySetup),
    `${setup.payload.length} brokers`,
  );
  const accounts = await callJson(client, "broker_accounts", {});
  check(
    "broker_accounts with nothing configured returns empty, not an error",
    !accounts.isError && accounts.payload.accounts?.length === 0 && accounts.payload.failures?.length === 0,
    `accounts=${accounts.payload.accounts?.length}, failures=${accounts.payload.failures?.length}`,
  );
}

// library_list_families
const families = await callJson(client, "library_list_families", {});
check(
  "library_list_families returns 17 families with counts",
  !families.isError &&
    families.payload.families?.length === 17 &&
    families.payload.families.every((f) => f.concept_count > 0),
  `total concepts: ${families.payload.families?.reduce((s, f) => s + f.concept_count, 0)}`,
);

// library_list_concepts (filtered)
const concepts = await callJson(client, "library_list_concepts", {
  family: "momentum",
  page_size: 5,
});
check(
  "library_list_concepts (momentum, 5/page) paginates",
  !concepts.isError &&
    concepts.payload.concepts?.length === 5 &&
    concepts.payload.total > 5 &&
    concepts.payload.concepts.every((c) => c.family === "momentum" && c.url),
  `total=${concepts.payload.total}, first=${concepts.payload.concepts?.[0]?.slug}`,
);

// library_search — alias-aware
const search = await callJson(client, "library_search", { query: "stochastics" });
const conceptHit = search.payload.results?.find((r) => r.kind === "concept");
check(
  "library_search('stochastics') finds concept via alias",
  !search.isError && !!conceptHit,
  conceptHit ? `${conceptHit.slug}${conceptHit.matched_alias ? ` (alias: ${conceptHit.matched_alias})` : ""}` : "no concept hit",
);

// library_search — indicators
const searchInd = await callJson(client, "library_search", {
  query: "trend",
  type: "indicators",
  limit: 3,
});
check(
  "library_search(type=indicators) returns indicator hits",
  !searchInd.isError &&
    searchInd.payload.results?.length > 0 &&
    searchInd.payload.results.every((r) => r.kind === "indicator" && r.url),
  `${searchInd.payload.results?.length} hits, first=${searchInd.payload.results?.[0]?.slug}`,
);

// library_get_concept — real slug from the roster
const conceptSlug = conceptHit?.slug ?? concepts.payload.concepts[0].slug;
const concept = await callJson(client, "library_get_concept", { slug: conceptSlug });
check(
  `library_get_concept('${conceptSlug}') returns markdown`,
  !concept.isError &&
    typeof concept.payload.content_markdown === "string" &&
    concept.payload.content_markdown.length > 200,
  `${concept.payload.content_markdown?.length} chars, family=${concept.payload.family}`,
);

// library_get_concept — unknown slug -> error + suggestions
const badConcept = await callJson(client, "library_get_concept", { slug: "stochastic" });
check(
  "library_get_concept(bad slug) errors with suggestions",
  badConcept.isError && /did you mean/i.test(badConcept.payload.error ?? ""),
  badConcept.payload.error,
);

// library_list_indicators
const indicators = await callJson(client, "library_list_indicators", { page_size: 3 });
check(
  "library_list_indicators paginates with explicit sort",
  !indicators.isError && indicators.payload.indicators?.length === 3 && indicators.payload.total > 3,
  `total=${indicators.payload.total}, first=${indicators.payload.indicators?.[0]?.slug}`,
);

// library_get_indicator + source code on a real slug
const indSlug = indicators.payload.indicators[0].slug;
const indicator = await callJson(client, "library_get_indicator", { slug: indSlug });
check(
  `library_get_indicator('${indSlug}') returns detail + code availability`,
  !indicator.isError &&
    typeof indicator.payload.body_markdown === "string" &&
    typeof indicator.payload.code?.available === "boolean",
  `code.available=${indicator.payload.code?.available}${indicator.payload.code?.reason ? `, reason=${indicator.payload.code.reason}` : ""}`,
);

const source = await callJson(client, "library_get_source_code", { slug: indSlug });
check(
  `library_get_source_code('${indSlug}') matches availability contract`,
  !source.isError &&
    (source.payload.available
      ? typeof source.payload.source === "string" && source.payload.source.length > 0
      : source.payload.reason === "runs-in-quant"),
  source.payload.available
    ? `${source.payload.source?.length} chars of source`
    : `reason=${source.payload.reason}, quant_url=${!!source.payload.quant_url}`,
);

// library_get_indicator — unknown slug
const badInd = await callJson(client, "library_get_indicator", { slug: "not-a-real-indicator-xyz" });
check("library_get_indicator(bad slug) returns isError", badInd.isError, badInd.payload.error);

// library_get_family
const family = await callJson(client, "library_get_family", { key: "smc-ict" });
check(
  "library_get_family('smc-ict') returns markdown + roster",
  !family.isError &&
    typeof family.payload.content_markdown === "string" &&
    family.payload.concepts?.length > 0,
  `${family.payload.content_markdown?.length} chars, ${family.payload.concepts?.length} concepts`,
);

// library_list_tags + tag/concept filters on library_list_indicators
const tags = await callJson(client, "library_list_tags", {});
check(
  "library_list_tags returns the tag vocabulary",
  !tags.isError && tags.payload.tags?.length > 0 && tags.payload.tags.every((t) => t.id && t.name),
  `${tags.payload.tags?.length} tags, first=${tags.payload.tags?.[0]?.name}`,
);

const byConcept = await callJson(client, "library_list_indicators", {
  concept: "rsi",
  page_size: 3,
});
check(
  "library_list_indicators(concept='rsi') filters server-side",
  !byConcept.isError && byConcept.payload.total > 0 && byConcept.payload.indicators.length > 0,
  `total=${byConcept.payload.total}, first=${byConcept.payload.indicators?.[0]?.slug}`,
);

// propfirms_search — unfiltered list
const firms = await callJson(client, "propfirms_search", { pageQuantity: 5 });
check(
  "propfirms_search lists firms with slugs",
  !firms.isError &&
    firms.payload.count > 0 &&
    firms.payload.firms?.length === 5 &&
    firms.payload.firms.every((f) => f.propfirmId && f.name),
  `count=${firms.payload.count}, first=${firms.payload.firms?.[0]?.propfirmId}`,
);

// propfirms_search — composed firm + nested challenge filters
const filteredFirms = await callJson(client, "propfirms_search", {
  accountSizeMin: 100000,
  steps: 2,
  newsTrading: true,
  pageQuantity: 100,
});
check(
  "propfirms_search composes nested challenge filters",
  !filteredFirms.isError &&
    filteredFirms.payload.count > 0 &&
    filteredFirms.payload.count < firms.payload.count,
  `count=${filteredFirms.payload.count} (of ${firms.payload.count} total firms)`,
);

// propfirms_get — full dossier on a real slug, compacted (no nulls, no
// duplicated offers: challenges reference the firm-level list via offerIds)
const firmSlug = firms.payload.firms[0].propfirmId;
const firm = await callJson(client, "propfirms_get", { propfirmId: firmSlug });
check(
  `propfirms_get('${firmSlug}') returns full dossier`,
  !firm.isError &&
    Array.isArray(firm.payload.firm?.challenges) &&
    Array.isArray(firm.payload.firm?.offers) &&
    typeof firm.payload.firm?.overview?.about === "string",
  `${firm.payload.firm?.challenges?.length} challenges, ${firm.payload.firm?.offers?.length} offers`,
);
check(
  "propfirms_get output is compacted",
  firm.payload.firm?.challenges?.every(
    (c) =>
      !("offers" in c) &&
      Object.values(c).every((v) => v !== null) &&
      (!c.offerIds || c.offerIds.every((id) => firm.payload.firm.offers.some((o) => o.offerId === id))),
  ),
  "no nulls, no embedded offers, offerIds resolve to firm-level offers",
);

// propfirms_get — unknown slug
const badFirm = await callJson(client, "propfirms_get", { propfirmId: "not-a-real-firm-xyz" });
check("propfirms_get(bad slug) returns isError", badFirm.isError, badFirm.payload.error);

// propfirms_search_challenges — rule filters scoped to one firm, offers
// lifted into a deduplicated top-level list with offerIds references
const challenges = await callJson(client, "propfirms_search_challenges", {
  propfirmId: [firmSlug],
  priceMax: 500,
  include: ["offers"],
  pageQuantity: 5,
});
check(
  `propfirms_search_challenges('${firmSlug}', priceMax=500) filters and lifts offers`,
  !challenges.isError &&
    challenges.payload.count > 0 &&
    Array.isArray(challenges.payload.offers) &&
    challenges.payload.challenges.every(
      (c) =>
        c.propfirmId === firmSlug &&
        c.price <= 500 &&
        !("offers" in c) &&
        (!c.offerIds ||
          c.offerIds.every((id) => challenges.payload.offers.some((o) => o.offerId === id))),
    ),
  `count=${challenges.payload.count}, lifted offers=${challenges.payload.offers?.length}`,
);

// propfirms_search_challenges — zero results on an uncaptured rule filter
// must come back with a warning, not a bare empty list
const zeroHit = await callJson(client, "propfirms_search_challenges", {
  maxLossMode: ["trailing-intraday-unrealized"],
  priceMax: 1,
});
check(
  "propfirms_search_challenges warns on zero results with rule filters",
  !zeroHit.isError &&
    zeroHit.payload.count === 0 &&
    Array.isArray(zeroHit.payload.warnings) &&
    /not captured/.test(zeroHit.payload.warnings[0] ?? ""),
  zeroHit.payload.warnings?.[0]?.slice(0, 80),
);

// propfirms_search_offers — live offers by challenge
const challengeId = challenges.payload.challenges?.[0]?.challengeId;
const offers = await callJson(client, "propfirms_search_offers", {
  challengeId: [challengeId],
});
check(
  `propfirms_search_offers(challengeId='${challengeId}') resolves live offers`,
  !offers.isError &&
    offers.payload.offers.every((o) => o.isActive && o.propfirmId === firmSlug),
  `count=${offers.payload.count}`,
);

// propfirms_search_offers — discount sort pushes valueless offers last
const byDiscount = await callJson(client, "propfirms_search_offers", {
  sort: "discountValue",
});
const discounts = byDiscount.payload.offers.map((o) => o.discountValue);
const firstValueless = discounts.findIndex((d) => d === undefined);
check(
  "propfirms_search_offers(sort=discountValue) puts valueless offers last",
  !byDiscount.isError &&
    (firstValueless === -1 || discounts.slice(firstValueless).every((d) => d === undefined)) &&
    (firstValueless === -1 || Array.isArray(byDiscount.payload.warnings)),
  `${discounts.filter((d) => d !== undefined).length} with value, ${discounts.filter((d) => d === undefined).length} without`,
);

/* ------------------------------------------------------------------ *
 * Simulator tools (prop-firm-sim engine)
 * ------------------------------------------------------------------ */

// propfirms_list_simulatable — the simulatable universe
const simFirms = await callStructured(client, "propfirms_list_simulatable", {});
check(
  "propfirms_list_simulatable returns simulatable firms",
  !simFirms.isError &&
    simFirms.data.firms?.length > 0 &&
    simFirms.data.firms.every((f) => f.firmId && Array.isArray(f.challenges)),
  `${simFirms.data.firms?.length} firms, first=${simFirms.data.firms?.[0]?.firmId}`,
);

const simFirm = simFirms.data.firms.find((f) => f.challenges.length >= 2) ?? simFirms.data.firms[0];
const simChallenge = simFirm.challenges[0];
const trader = { winRate: 0.48, avgWinR: 1.6, tradesPerDay: 4, riskValue: 1 };

// propfirms_challenge_rules — the encoded spec
const rules = await callStructured(client, "propfirms_challenge_rules", {
  firmId: simFirm.firmId,
  challengeId: simChallenge.challengeId,
});
check(
  `propfirms_challenge_rules('${simFirm.firmId}/${simChallenge.challengeId}') returns the encoded spec`,
  !rules.isError &&
    rules.data.challenge?.challengeId === simChallenge.challengeId &&
    !!rules.data.challenge?.maxLoss?.mode &&
    !!rules.data.provenance,
  `provenance=${rules.data.provenance}, maxLoss.mode=${rules.data.challenge?.maxLoss?.mode}`,
);

// propfirms_simulate — Monte Carlo with a parametric trader
const sim = await callStructured(client, "propfirms_simulate", {
  firmId: simFirm.firmId,
  challengeId: simChallenge.challengeId,
  ...trader,
  paths: 2000,
});
const passProb = sim.data.perAttempt?.passProbability;
check(
  "propfirms_simulate returns pass probability with CI and EV",
  !sim.isError &&
    passProb >= 0 &&
    passProb <= 1 &&
    sim.data.perAttempt.passProbabilityCi.low <= passProb &&
    typeof sim.data.ev?.evTotal === "number" &&
    sim.data.meta?.seed === 42,
  `pass/attempt=${(passProb * 100).toFixed(1)}%, EV=${Math.round(sim.data.ev?.evTotal)}`,
);

// determinism: same seed, same numbers
const sim2 = await callStructured(client, "propfirms_simulate", {
  firmId: simFirm.firmId,
  challengeId: simChallenge.challengeId,
  ...trader,
  paths: 2000,
});
check(
  "propfirms_simulate is deterministic under seed",
  !sim2.isError && sim2.data.perAttempt.passProbability === passProb,
  `both runs: ${passProb}`,
);

// propfirms_optimal_risk — pass-optimal vs EV-optimal sweep
const sweep = await callStructured(client, "propfirms_optimal_risk", {
  firmId: simFirm.firmId,
  challengeId: simChallenge.challengeId,
  winRate: trader.winRate,
  avgWinR: trader.avgWinR,
  tradesPerDay: trader.tradesPerDay,
  min: 0.5,
  max: 1.5,
  step: 0.5,
  paths: 1000,
});
check(
  "propfirms_optimal_risk sweeps the risk grid",
  !sweep.isError && Object.keys(sweep.data).length > 0 && /risk/i.test(sweep.text),
  Object.keys(sweep.data).slice(0, 5).join(", "),
);

// propfirms_compare — same trader across two challenges
const compareIds = simFirm.challenges.slice(0, 2).map((c) => ({
  firmId: simFirm.firmId,
  challengeId: c.challengeId,
}));
const compared = await callStructured(client, "propfirms_compare", {
  challenges: compareIds,
  ...trader,
  paths: 1000,
});
check(
  "propfirms_compare simulates all entries",
  !compared.isError && Object.keys(compared.data).length > 0 && /EV/.test(compared.text),
  `${compareIds.length} challenges compared`,
);

// propfirms_simulate_trades — from a real R-multiple series
const rSeries = Array.from({ length: 60 }, (_, i) => (i % 5 < 2 ? 1.8 : i % 5 === 4 ? 2.2 : -1));
const boot = await callStructured(client, "propfirms_simulate_trades", {
  firmId: simFirm.firmId,
  challengeId: simChallenge.challengeId,
  rSeries,
  tradesPerDay: 4,
  riskValue: 1,
  paths: 1000,
});
check(
  "propfirms_simulate_trades runs the block bootstrap",
  !boot.isError &&
    boot.data.perAttempt?.passProbability >= 0 &&
    boot.data.perAttempt?.passProbability <= 1,
  `pass/attempt=${(boot.data.perAttempt?.passProbability * 100).toFixed(1)}%`,
);

// propfirms_pass_rates — the reference-archetype odds
const rates = await callStructured(client, "propfirms_pass_rates", {
  firmId: simFirm.firmId,
  challengeId: simChallenge.challengeId,
});
check(
  "propfirms_pass_rates returns all three archetypes",
  !rates.isError &&
    rates.data.challenges?.length === 1 &&
    rates.data.challenges[0].byArchetype?.length === 3 &&
    rates.data.seed === 42 &&
    rates.data.paths === 10000,
  rates.data.challenges?.[0]?.byArchetype
    ?.map((a) => `${a.archetypeId}=${a.passPerAttemptPct.toFixed(1)}%`)
    .join(", "),
);

// propfirms_validate_strategy — screen against an explicit bar
const screened = await callStructured(client, "propfirms_validate_strategy", {
  winRate: 0.5,
  avgWinR: 1.6,
  tradesPerDay: 4,
  riskValue: 0.5,
  firm: simFirm.firmId,
  minPassPerAttempt: 0.6,
  paths: 500,
});
const screenedTotal = (screened.data.passing?.length ?? 0) + (screened.data.belowBar?.length ?? 0);
check(
  `propfirms_validate_strategy screens ${simFirm.firmId}'s challenges against the bar`,
  !screened.isError &&
    screenedTotal === simFirm.challenges.length &&
    screened.data.bar?.minPassPerAttempt === 0.6 &&
    [...(screened.data.passing ?? []), ...(screened.data.belowBar ?? [])].every(
      (row) => typeof row.passPerAttempt === "number" && row.meetsBar === row.passPerAttempt >= 0.6,
    ),
  `${screened.data.passing?.length} pass the bar, ${screened.data.belowBar?.length} below (of ${screenedTotal})`,
);

// propfirms_validate_strategy — over-cap scope must refuse, not truncate
const overCap = await callStructured(client, "propfirms_validate_strategy", {
  winRate: 0.5,
  avgWinR: 1.6,
  tradesPerDay: 4,
  riskValue: 0.5,
  paths: 100,
});
check(
  "propfirms_validate_strategy refuses over-cap scopes explicitly",
  overCap.isError && /cap of 40/.test(overCap.text),
  overCap.text.slice(0, 80),
);

/* ------------------------------------------------------------------ *
 * Market Trackers tools (CC0 dumps at github.com/LuxAlgo/market-trackers-data)
 * ------------------------------------------------------------------ */

// trackers_datasets — the full catalog with live coverage from the manifest
const catalog = await callJson(client, "trackers_datasets", {});
check(
  "trackers_datasets lists all 18 datasets with rows, freshness and years",
  !catalog.isError &&
    catalog.payload.datasets?.length === 18 &&
    catalog.payload.datasets.every((d) => d.id && d.title && typeof d.rows === "number") &&
    catalog.payload.datasets.some((d) => d.rows > 0 && d.years) &&
    catalog.payload.license === "CC0-1.0",
  `generatedAt=${catalog.payload.generatedAt}, with rows: ${catalog.payload.datasets?.filter((d) => d.rows > 0).length}`,
);

// trackers_datasets(dataset) — field roster, filter paths, per-year coverage, source health
const insiderInfo = await callJson(client, "trackers_datasets", { dataset: "insider-transactions" });
const insiderDetail = insiderInfo.payload.datasets?.[0];
check(
  "trackers_datasets(insider-transactions) returns fields, paths, coverage and source health",
  !insiderInfo.isError &&
    insiderDetail?.fields?.includes("ticker") &&
    insiderDetail?.tickerPaths?.includes("ticker") &&
    Array.isArray(insiderDetail?.coverage) &&
    insiderDetail.coverage.length > 0 &&
    insiderDetail?.sources?.[0]?.id === "edgar",
  `${insiderDetail?.fields?.length} fields, years=${insiderDetail?.years}, canary=${insiderDetail?.sources?.[0]?.lastCanaryStatus}`,
);

// trackers_query — newest year, unfiltered, newest-first, provenance on every row
const newest = await callJson(client, "trackers_query", { dataset: "insider-transactions", limit: 3 });
const newestRows = newest.payload.rows ?? [];
check(
  "trackers_query(insider-transactions) streams the newest year and returns cited rows",
  !newest.isError &&
    newest.payload.matched > 0 &&
    newestRows.length === 3 &&
    newestRows.every((r) => typeof r.provenance?.sourceUrl === "string") &&
    newest.payload.scanned?.length > 0,
  `matched=${newest.payload.matched}, years=${JSON.stringify(newest.payload.years)}, scanned=${newest.payload.scanned?.map((s) => `${s.year}/${s.location}`).join(",")}`,
);

// trackers_query — ticker filter round-trips a ticker seen in the unfiltered page
const knownTicker = newestRows.find((r) => typeof r.ticker === "string")?.ticker;
if (knownTicker) {
  const byTicker = await callJson(client, "trackers_query", {
    dataset: "insider-transactions",
    ticker: knownTicker.toLowerCase(),
    limit: 10,
  });
  check(
    `trackers_query(ticker='${knownTicker}') filters case-insensitively`,
    !byTicker.isError &&
      byTicker.payload.matched > 0 &&
      byTicker.payload.rows.every((r) => r.ticker === knownTicker),
    `matched=${byTicker.payload.matched}`,
  );
}

// trackers_query — exact field match via where
const buys = await callJson(client, "trackers_query", {
  dataset: "congress-trades",
  where: { side: "buy" },
  limit: 5,
});
check(
  "trackers_query(where side=buy) applies exact field filters",
  !buys.isError && buys.payload.rows.every((r) => r.side === "buy"),
  `matched=${buys.payload.matched}`,
);

// trackers_query — the byte budget refuses oversized selections with guidance, before any download
const tooBig = await callJson(client, "trackers_query", {
  dataset: "patents",
  years: [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025],
  text: "nvidia",
});
check(
  "trackers_query refuses over-budget year selections explicitly",
  tooBig.isError && /budget/.test(tooBig.payload.error ?? ""),
  tooBig.payload.error?.slice(0, 90),
);

// trackers_latest — the newest daily delta
const latest = await callJson(client, "trackers_latest", { dataset: "insider-transactions", limit: 3 });
check(
  "trackers_latest(insider-transactions) returns the newest daily delta",
  !latest.isError && latest.payload.rowsInDelta > 0 && latest.payload.rows.length > 0,
  `rowsInDelta=${latest.payload.rowsInDelta}, lastIngestedAt=${latest.payload.lastIngestedAt}`,
);

// trackers_latest — snapshot-only datasets have no delta
const noDelta = await callJson(client, "trackers_latest", { dataset: "patents" });
check(
  "trackers_latest(patents) explains snapshot-only datasets",
  noDelta.isError && /snapshot-only/.test(noDelta.payload.error ?? ""),
  noDelta.payload.error?.slice(0, 80),
);

// trackers_ticker — fan-out across every ticker-bearing dataset
const overview = await callJson(client, "trackers_ticker", { ticker: knownTicker ?? "AAPL", limit: 2 });
check(
  `trackers_ticker('${knownTicker ?? "AAPL"}') fans out across ticker-bearing datasets`,
  !overview.isError &&
    overview.payload.datasets?.length >= 10 &&
    overview.payload.datasets.every((d) => d.dataset && typeof d.matched === "number") &&
    (!knownTicker ||
      overview.payload.datasets.find((d) => d.dataset === "insider-transactions")?.matched > 0),
  overview.payload.datasets
    ?.filter((d) => d.matched > 0)
    .map((d) => `${d.dataset}=${d.matched}`)
    .join(", ") || "no matches",
);

/* ------------------------------------------------------------------
 * Edge Stats tools (hosted derived store)
 * ------------------------------------------------------------------ */

// edge_symbols — coverage of the hosted store
const edgeSymbols = await callJson(client, "edge_symbols", {});
check(
  "edge_symbols reports hosted symbols with coverage and build info",
  !edgeSymbols.isError &&
    Array.isArray(edgeSymbols.payload.symbols) &&
    edgeSymbols.payload.symbols.length > 0 &&
    typeof edgeSymbols.payload.builtAt === "string" &&
    edgeSymbols.payload.symbols.every(
      (s) => typeof s.symbol === "string" && Array.isArray(s.sessions),
    ),
  edgeSymbols.isError
    ? edgeSymbols.payload.error
    : edgeSymbols.payload.symbols?.map((s) => s.symbol).join(", "),
);

// edge_presets — the precomputed catalog
const edgePresets = await callJson(client, "edge_presets", {});
check(
  "edge_presets lists the preset catalog with categories",
  !edgePresets.isError &&
    Array.isArray(edgePresets.payload.presets) &&
    edgePresets.payload.presets.length >= 30 &&
    edgePresets.payload.presets.every((p) => p.id && p.title && p.summary),
  edgePresets.isError
    ? edgePresets.payload.error
    : `${edgePresets.payload.presets?.length} presets, categories: ${edgePresets.payload.categories?.join(", ")}`,
);

// edge_report — one envelope, honesty fields intact
const edgeSymbol = edgeSymbols.payload.symbols?.[0]?.symbol;
const edgeReport = await callJson(client, "edge_report", {
  preset: "day-of-week",
  symbol: edgeSymbol ?? "BTCUSDT",
});
check(
  "edge_report returns the full honesty envelope (N, CI, guards, disclaimer)",
  !edgeReport.isError &&
    typeof edgeReport.payload.n === "number" &&
    (edgeReport.payload.estimate === null || typeof edgeReport.payload.estimate === "number") &&
    typeof edgeReport.payload.disclaimer === "string" &&
    edgeReport.payload.guards !== undefined,
  edgeReport.isError
    ? edgeReport.payload.error
    : `n=${edgeReport.payload.n} estimate=${edgeReport.payload.estimate}`,
);

// edge_report — unknown symbol refuses with guidance, never guesses
const edgeMiss = await callJson(client, "edge_report", { preset: "gap-fill", symbol: "NOPE" });
check(
  "edge_report refuses an unhosted symbol and names the hosted ones",
  edgeMiss.isError && /not in the hosted store/.test(edgeMiss.payload.error ?? ""),
  (edgeMiss.payload.error ?? "").slice(0, 80),
);

await client.close();
console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);

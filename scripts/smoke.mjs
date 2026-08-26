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
];
const names = tools.map((t) => t.name).sort();
check(
  `tools/list exposes all ${expected.length} tools`,
  expected.slice().sort().every((n, i) => names[i] === n),
  names.join(", "),
);

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

await client.close();
console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);

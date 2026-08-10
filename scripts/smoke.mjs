/*
  End-to-end smoke test: connects a real MCP client to the built server
  over stdio, lists tools, and calls all eight against the live LuxAlgo
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
  "library_get_pine_source",
  "library_list_concepts",
  "library_list_indicators",
  "library_list_families",
  "library_get_family",
];
const names = tools.map((t) => t.name).sort();
check(
  "tools/list exposes all 8 tools",
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

// library_get_indicator + pine source on a real slug
const indSlug = indicators.payload.indicators[0].slug;
const indicator = await callJson(client, "library_get_indicator", { slug: indSlug });
check(
  `library_get_indicator('${indSlug}') returns detail + pine availability`,
  !indicator.isError &&
    typeof indicator.payload.body_markdown === "string" &&
    typeof indicator.payload.pine?.available === "boolean",
  `pine.available=${indicator.payload.pine?.available}${indicator.payload.pine?.reason ? `, reason=${indicator.payload.pine.reason}` : ""}`,
);

const pine = await callJson(client, "library_get_pine_source", { slug: indSlug });
check(
  `library_get_pine_source('${indSlug}') matches availability contract`,
  !pine.isError &&
    (pine.payload.available
      ? typeof pine.payload.source === "string" && pine.payload.source.length > 0
      : pine.payload.reason === "runs-in-quant"),
  pine.payload.available ? `${pine.payload.source?.length} chars of Pine` : `reason=${pine.payload.reason}, quant_url=${!!pine.payload.quant_url}`,
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

await client.close();
console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);

/* Library tools against the live app API. */

import { chartUrl, quantUrl } from "../../dist/tools/library/urls.js";

const CHART_ORIGIN = process.env.LUXALGO_CHART_ORIGIN ?? "https://vela.luxalgo.com";
const APP_ORIGIN = process.env.LUXALGO_APP_ORIGIN ?? "https://app.luxalgo.com";

export async function run({ client, check, callJson, httpUrl }) {
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
        ? typeof source.payload.source === "string" &&
          source.payload.source.length > 0 &&
          (source.payload.complete === true ||
            (source.payload.complete === false && source.payload.total_lines > source.payload.shown_lines))
        : source.payload.reason === "runs-in-quant" &&
          (!source.payload.chart_url || source.payload.chart_url.startsWith(`${CHART_ORIGIN}/chart?pineScriptCodeId=`))),
    source.payload.available
      ? `${source.payload.source?.length} chars of source`
      : `reason=${source.payload.reason}, chart_url=${!!source.payload.chart_url}, quant_url=${!!source.payload.quant_url}`,
  );

  // Chart links. Most Library indicators serve their source, so the live call above rarely
  // returns one; check the links this build hands out directly.
  check(
    "an indicator that runs only on LuxAlgo links to it on a Vela chart",
    chartUrl("abc 123") === `${CHART_ORIGIN}/chart?pineScriptCodeId=abc%20123`,
    chartUrl("abc 123"),
  );
  check(
    "existing clients keep the quant_url link they already read",
    quantUrl("abc 123") === `${APP_ORIGIN}/quant?pineScriptCodeId=abc%20123`,
    quantUrl("abc 123"),
  );

  // Vela chart links ("Open in Vela") on every result that names an indicator with a Vela script.
  const chartPrefix = `${CHART_ORIGIN}/chart?pineScriptCodeId=`;
  const linksToVela = (row) => typeof row?.chart_url === "string" && row.chart_url.startsWith(chartPrefix);

  const obSearch = await callJson(client, "library_search", { query: "order blocks", type: "indicators", limit: 5 });
  check(
    "an indicator found by search links to it on a Vela chart",
    !obSearch.isError && obSearch.payload.results?.length > 0 && obSearch.payload.results.every(linksToVela),
    `${obSearch.payload.results?.filter(linksToVela).length}/${obSearch.payload.results?.length} hits with chart_url`,
  );

  const supertrend = await callJson(client, "library_list_indicators", { text: "supertrend", page_size: 5 });
  check(
    "every indicator in a listing that runs on Vela links to it on a Vela chart",
    !supertrend.isError && supertrend.payload.indicators?.length > 0 && supertrend.payload.indicators.every(linksToVela),
    `${supertrend.payload.indicators?.filter(linksToVela).length}/${supertrend.payload.indicators?.length} with chart_url`,
  );

  const dob = await callJson(client, "library_get_indicator", { slug: "dynamic-order-blocks" });
  check("an indicator's page links to it on a Vela chart", !dob.isError && linksToVela(dob.payload), dob.payload.chart_url ?? "no chart_url");

  const dobSource = await callJson(client, "library_get_source_code", { slug: "dynamic-order-blocks" });
  check(
    "an indicator's source code comes with its Vela chart link, complete source included",
    !dobSource.isError && dobSource.payload.available === true && linksToVela(dobSource.payload),
    `complete=${dobSource.payload.complete}, chart_url=${!!dobSource.payload.chart_url}`,
  );
  check(
    "the source code's chart link opens the same script as the indicator's page",
    dobSource.payload.chart_url === dob.payload.chart_url,
  );

  // The few Library entries with no Vela script (the toolkit products) get no link, never a made-up one.
  const noScript = await callJson(client, "library_get_indicator", { slug: "luxalgo-backtester-osc" });
  check(
    "an indicator with no Vela script gets no chart link",
    !noScript.isError && !("chart_url" in noScript.payload),
    noScript.isError ? noScript.payload.error : `chart_url=${!!noScript.payload.chart_url}`,
  );

  const rsiConcept = await callJson(client, "library_get_concept", { slug: "rsi" });
  check(
    "a concept lists its indicators, each linking to it on a Vela chart",
    !rsiConcept.isError &&
      rsiConcept.payload.indicators?.length > 0 &&
      rsiConcept.payload.indicators.every((row) => row.slug && row.name && linksToVela(row)),
    `${rsiConcept.payload.indicators?.length} indicators`,
  );

  // library_get_indicator — unknown slug
  const badInd = await callJson(client, "library_get_indicator", { slug: "not-a-real-indicator-xyz" });
  check("library_get_indicator(bad slug) returns isError", badInd.isError, badInd.payload.error);

  // library_get_family
  const family = await callJson(client, "library_get_family", { key: "smc-ict" });
  check(
    "a family hub is its written page, whose roster links every concept once, without a repeated list",
    !family.isError &&
      typeof family.payload.content_markdown === "string" &&
      family.payload.concept_count > 0 &&
      !("concepts" in family.payload) &&
      (family.payload.content_markdown.match(/\/library\/concept\//g) ?? []).length >= family.payload.concept_count,
    `${JSON.stringify(family.payload).length} B, ${family.payload.concept_count} concepts`,
  );

  // A repeated indicator query is answered from the in-process cache.
  const repeatQuery = { text: "supertrend", page_size: 5 };
  const first = await callJson(client, "library_list_indicators", repeatQuery);
  const startedAt = performance.now();
  const again = await callJson(client, "library_list_indicators", repeatQuery);
  const repeatMs = performance.now() - startedAt;
  check(
    "asking the same indicator question twice answers the second time at once, with the same result",
    !again.isError && JSON.stringify(again.payload) === JSON.stringify(first.payload) && repeatMs < 1_000,
    `${Math.round(repeatMs)} ms, total=${again.payload.total}`,
  );

  // Families and concepts organize the Library; the retired tags never reach agents.
  const { tools } = await client.listTools();
  const listIndicatorsInputs = Object.keys(tools.find((t) => t.name === "library_list_indicators")?.inputSchema?.properties ?? {});
  check(
    "the Library is browsed by family and concept, and indicator listings carry no tags",
    listIndicatorsInputs.includes("family") &&
      listIndicatorsInputs.includes("concept") &&
      !listIndicatorsInputs.includes("tags") &&
      indicators.payload.indicators?.every((row) => !("tags" in row)),
    `inputs: ${listIndicatorsInputs.join(", ")}`,
  );

  // concept filter on library_list_indicators
  const byConcept = await callJson(client, "library_list_indicators", {
    concept: "rsi",
    page_size: 3,
  });
  check(
    "library_list_indicators(concept='rsi') filters server-side",
    !byConcept.isError && byConcept.payload.total > 0 && byConcept.payload.indicators.length > 0,
    `total=${byConcept.payload.total}, first=${byConcept.payload.indicators?.[0]?.slug}`,
  );
}

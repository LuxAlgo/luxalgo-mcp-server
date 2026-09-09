/* Market Trackers tools against the live CC0 dumps. */

export async function run({ client, check, callJson, httpUrl }) {
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
}

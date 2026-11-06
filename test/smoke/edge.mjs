/* Edge Stats tools against the hosted derived store. */

export async function run({ client, check, callJson, httpUrl }) {
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

  // Vela chart links: a hosted symbol is one exact market (Binance spot), opened at an interval that suits the question.
  const chartOrigin = process.env.LUXALGO_CHART_ORIGIN ?? "https://vela.luxalgo.com";
  const openingRange = await callJson(client, "edge_report", { preset: "orb", symbol: "BTCUSDT" });
  check(
    "an Edge Stats report links to its market on a Vela chart, on intraday bars for an intraday question",
    !openingRange.isError && openingRange.payload.chart_url === `${chartOrigin}/chart?symbol=binance:BTCUSDT&tf=15`,
    openingRange.payload.chart_url ?? openingRange.payload.error,
  );
  check(
    "a day-of-week report opens its market on daily bars",
    !edgeReport.isError && edgeReport.payload.chart_url === `${chartOrigin}/chart?symbol=binance:BTCUSDT&tf=D`,
    edgeReport.payload.chart_url,
  );
  check(
    "every hosted symbol links to its market on a Vela chart",
    !edgeSymbols.isError &&
      edgeSymbols.payload.symbols?.every((s) => s.chart_url === `${chartOrigin}/chart?symbol=${s.adapter}:${s.symbol}&tf=D`),
    edgeSymbols.payload.symbols?.map((s) => s.chart_url).join(", "),
  );
  // Opening gaps on a market that never closes are an artefact of the calendar day.
  const roundTheClock = edgeSymbols.payload.symbols?.find((s) => s.assetClass === "crypto")?.symbol;
  if (roundTheClock) {
    const gap = await callJson(client, "edge_report", { preset: "gap-fill", symbol: roundTheClock });
    check(
      `gap statistics on ${roundTheClock}, which trades around the clock, are refused with the reason and the presets that apply`,
      gap.isError &&
        /trades around the clock/.test(gap.payload.error ?? "") &&
        /Presets that apply/.test(gap.payload.error ?? "") &&
        !/Presets that apply[^.]*gap-fill/.test(gap.payload.error ?? ""),
      (gap.payload.error ?? "").slice(0, 100),
    );
    const gapPreset = edgePresets.payload.presets?.find((p) => p.id === "gap-fill");
    check(
      "the preset catalog marks gap presets as not applicable to round-the-clock symbols",
      gapPreset?.not_applicable_to?.includes(roundTheClock) &&
        !("not_applicable_to" in (edgePresets.payload.presets?.find((p) => p.id === "day-of-week") ?? {})),
      JSON.stringify(gapPreset?.not_applicable_to),
    );
  }

  // edge_report — unknown symbol refuses with guidance, never guesses
  const edgeMiss = await callJson(client, "edge_report", { preset: "gap-fill", symbol: "NOPE" });
  check(
    "edge_report refuses an unhosted symbol and names the hosted ones",
    edgeMiss.isError && /not in the hosted store/.test(edgeMiss.payload.error ?? ""),
    (edgeMiss.payload.error ?? "").slice(0, 80),
  );
}

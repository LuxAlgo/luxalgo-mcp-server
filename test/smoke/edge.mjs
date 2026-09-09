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

  // edge_report — unknown symbol refuses with guidance, never guesses
  const edgeMiss = await callJson(client, "edge_report", { preset: "gap-fill", symbol: "NOPE" });
  check(
    "edge_report refuses an unhosted symbol and names the hosted ones",
    edgeMiss.isError && /not in the hosted store/.test(edgeMiss.payload.error ?? ""),
    (edgeMiss.payload.error ?? "").slice(0, 80),
  );
}

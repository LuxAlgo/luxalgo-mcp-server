/* Prop-firm directory + simulator tools against the live directory. */

export async function run({ client, check, callJson, callStructured }) {
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
}

/*
  propfirms_pass_rates — the reference-archetype odds luxalgo.com/prop-firms
  publishes, recomputed live from the directory's encoded rules with the same
  engine, seed and path count. Deterministic per ruleset and cached.
*/
import { z } from "zod";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import {
  ChallengeSpecSchema,
  DISCLAIMER,
  ENGINE_VERSION,
  simulate,
  type ChallengeSpec,
  type SimResult,
  type TraderProfileInput,
} from "@luxalgo/prop-firm-sim-core";
import { adaptFirm } from "@luxalgo/prop-firm-sim-core/directory";
import { fetchDirectory, resolveFirm } from "@luxalgo/prop-firm-sim-mcp/directory";
import { fmtMoney } from "../../_shared/format.js";
import { PRECOMPUTED_PATHS, PRECOMPUTED_SEED, ok, requireAdaptedChallenge, safely, simError } from "./shared.js";

/*
  Reference archetypes — MUST stay in sync with the site's reference
  simulator profiles: the whole point of this tool is returning the exact
  numbers luxalgo.com/prop-firms publishes.
*/
interface TraderArchetype {
  id: "developing" | "consistent" | "edge";
  label: string;
  description: string;
  profile: TraderProfileInput;
}

const TRADER_ARCHETYPES: TraderArchetype[] = [
  {
    id: "developing",
    label: "Developing trader",
    description: "45% win rate, 1.4R average winner, 4 trades/day, risking 1% per trade",
    profile: {
      kind: "parametric",
      winRate: 0.45,
      avgWinR: 1.4,
      avgLossR: 1,
      tradesPerDay: 4,
      tradesPerDayModel: "poisson",
      risk: { mode: "percent-of-initial", value: 1 },
    },
  },
  {
    id: "consistent",
    label: "Consistent trader",
    description: "48% win rate, 1.6R average winner, 4 trades/day, risking 0.75% per trade",
    profile: {
      kind: "parametric",
      winRate: 0.48,
      avgWinR: 1.6,
      avgLossR: 1,
      tradesPerDay: 4,
      tradesPerDayModel: "poisson",
      risk: { mode: "percent-of-initial", value: 0.75 },
    },
  },
  {
    id: "edge",
    label: "Proven edge",
    description: "52% win rate, 1.8R average winner, 3 trades/day, risking 0.5% per trade",
    profile: {
      kind: "parametric",
      winRate: 0.52,
      avgWinR: 1.8,
      avgLossR: 1,
      tradesPerDay: 3,
      tradesPerDayModel: "poisson",
      risk: { mode: "percent-of-initial", value: 0.5 },
    },
  },
];

const passRatesSchema = z.object({
  firmId: z
    .string()
    .min(1)
    .describe("Directory firm id (propfirmId, e.g. 'ftmo') or firm name — from propfirms_list_simulatable."),
  challengeId: z
    .string()
    .min(1)
    .optional()
    .describe("One challenge id. Omit to compute every simulatable challenge the firm has."),
});

/** Deterministic per exact ruleset, so cache on the spec itself. */
const passRateCache = new Map<string, Record<string, unknown>>();

function archetypeSummary(result: SimResult, archetype: TraderArchetype): Record<string, unknown> {
  return {
    archetypeId: archetype.id,
    label: archetype.label,
    description: archetype.description,
    passPerAttemptPct: result.perAttempt.passProbability * 100,
    passCiLowPct: result.perAttempt.passProbabilityCi.low * 100,
    passCiHighPct: result.perAttempt.passProbabilityCi.high * 100,
    fundedWithinCapPct: result.journey.fundedProbability * 100,
    expectedAttempts: result.journey.attempts.mean,
    expectedCostUsd: result.journey.cost.mean,
    evTotalUsd: result.ev.evTotal,
    pEvPositivePct: result.ev.pPositive * 100,
    payoutProbabilityPct:
      result.funded && Number.isFinite(result.funded.payoutProbability)
        ? result.funded.payoutProbability * 100
        : null,
    fundedBlownPct:
      result.funded && Number.isFinite(result.funded.blownProbability)
        ? result.funded.blownProbability * 100
        : null,
    daysToFundedP50: result.journey.daysToFunded?.p50 ?? null,
    flagIds: result.assumptions.flags.map((flag) => flag.id),
  };
}

function challengePassRates(
  firmId: string,
  spec: ChallengeSpec,
  provenance: string,
  inferredFields: string[],
): Record<string, unknown> {
  const key = `${firmId}/${spec.challengeId}:${JSON.stringify(spec)}`;
  const cached = passRateCache.get(key);
  if (cached !== undefined) return cached;
  const lastVerified =
    (spec.sources ?? [])
      .map((source) => source.lastVerified)
      .sort()
      .at(-1) ?? null;
  const entry = {
    challengeId: spec.challengeId,
    name: spec.name,
    accountSize: spec.accountSize,
    currency: spec.currency,
    lastVerified,
    provenance,
    inferredFields,
    byArchetype: TRADER_ARCHETYPES.map((archetype) =>
      archetypeSummary(
        simulate(spec, archetype.profile, {
          paths: PRECOMPUTED_PATHS,
          seed: PRECOMPUTED_SEED,
          includeHistograms: false,
        }),
        archetype,
      ),
    ),
  };
  passRateCache.set(key, entry);
  return entry;
}

function handlePassRates(input: unknown): Promise<CallToolResult> {
  return safely(async () => {
    const args = passRatesSchema.parse(input);
    const rows = await fetchDirectory();
    // Throws readable errors listing what actually exists.
    const firm = resolveFirm(rows, args.firmId);
    const adaptedAll = args.challengeId
      ? [requireAdaptedChallenge(firm, args.challengeId)]
      : adaptFirm(firm);
    if (adaptedAll.length === 0) {
      return simError(
        `No challenge of '${firm.name}' carries rule semantics the engine can adapt honestly. ` +
          "Simulate via an inline `spec` with propfirms_simulate instead.",
      );
    }

    const challenges = adaptedAll.map((adapted) =>
      challengePassRates(
        adapted.propfirmId,
        ChallengeSpecSchema.parse(adapted.spec),
        adapted.provenance,
        adapted.inferredFields,
      ),
    );
    const firmName = adaptedAll[0]!.firmName;
    const propfirmId = adaptedAll[0]!.propfirmId;

    const lines: string[] = [];
    lines.push(
      `Reference pass rates for ${firmName} — computed live from the directory's encoded rules with the ` +
        `same engine, seed (${PRECOMPUTED_SEED}), path count (${PRECOMPUTED_PATHS.toLocaleString("en-US")}) ` +
        "and reference trader archetypes that luxalgo.com/prop-firms uses; not the user's personal odds:",
    );
    for (const challenge of challenges) {
      const byArchetype = challenge.byArchetype as ReturnType<typeof archetypeSummary>[];
      lines.push(
        `${String(challenge.name)} (${String(challenge.challengeId)}, ` +
          `${fmtMoney(Number(challenge.accountSize), String(challenge.currency))}): ` +
          byArchetype
            .map(
              (row) =>
                `${String(row.archetypeId)} ${Number(row.passPerAttemptPct).toFixed(1)}% per attempt ` +
                `(expected cost ${fmtMoney(Number(row.expectedCostUsd), String(challenge.currency))})`,
            )
            .join(" | "),
      );
      const inferred = challenge.inferredFields as string[];
      if (inferred.length > 0) {
        lines.push(`  Semantics inferred from listing text: ${inferred.join(", ")} — relay to the user.`);
      }
      if (challenge.lastVerified !== null) {
        lines.push(`  Rules last verified ${String(challenge.lastVerified)} — the firm's page is authoritative.`);
      }
    }
    lines.push(
      "Archetypes span the realistic range so the best case is never mistaken for the base case. For " +
        "the user's OWN statistics run propfirms_simulate (or propfirms_simulate_trades with " +
        "their real trades).",
    );
    lines.push(DISCLAIMER);

    return ok(lines.join("\n"), {
      firmId: propfirmId,
      firmName,
      challenges,
      seed: PRECOMPUTED_SEED,
      paths: PRECOMPUTED_PATHS,
      engineVersion: ENGINE_VERSION,
      disclaimer: DISCLAIMER,
    });
  });
}

export function registerPassRatesTool(server: McpServer): void {
  server.registerTool(
    "propfirms_pass_rates",
    {
      title: "Reference pass rates per archetype",
      description:
        "Reference challenge pass rates computed live from the directory's encoded rules with the same " +
        "engine, seed (42), path count (10,000) and reference archetypes luxalgo.com/prop-firms uses — " +
        "per challenge and per archetype (developing 45% win rate / consistent 48% / proven edge 52%, " +
        "all risking conservatively). Returns per-attempt pass probability with 95% CI, P(funded), " +
        "expected attempts and total cost, EV, payout probability, funded-blowup probability, each " +
        "cell's assumption flag ids, and the ruleset's provenance (structured directory columns vs " +
        "fields inferred from listing text — always relay inferred fields). Deterministic per ruleset " +
        "and cached — cheap to call. These are REFERENCE odds for orientation and comparison, not the " +
        "user's personal odds: for their own statistics use propfirms_simulate (summary stats) " +
        "or propfirms_simulate_trades (their real trade series). Not a ranking; a firm's page is " +
        "authoritative for current rules (check lastVerified). Expected costs use the directory's " +
        "listed challenge prices; full firm profiles and live offers are directory data " +
        "(propfirms_get, propfirms_search_offers).",
      inputSchema: passRatesSchema,
    },
    (args: unknown) => handlePassRates(args),
  );
}

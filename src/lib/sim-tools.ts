/*
  Prop-firm challenge simulation tools, backed by the open-source
  prop-firm-sim engine (github.com/LuxAlgo/prop-firm-sim) via its published
  npm packages:

  - Six tools re-registered from @luxalgo/prop-firm-sim-mcp's exported
    toolDefinitions under this repo's propfirms_ naming convention
    (cross-references inside the descriptions are rewritten to the local
    names): propfirms_list_simulatable, propfirms_challenge_rules,
    propfirms_simulate, propfirms_optimal_risk, propfirms_compare,
    propfirms_simulate_trades.
  - propfirms_pass_rates: the reference-archetype odds
    luxalgo.com/prop-firms publishes, recomputed live from the directory's
    encoded rules with the same engine, seed, and path count.
  - propfirms_validate_strategy: one strategy screened across every
    simulatable directory challenge against an explicit, caller-stated bar.

  The Monte Carlo engine runs locally in this process; the only network is
  the public prop-firm directory (fetched and cached by the sim package,
  LUXALGO_APP_ORIGIN-aware). Results are deterministic under seed.
*/
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ChallengeSpecSchema,
  DISCLAIMER,
  ENGINE_VERSION,
  parseRSeries,
  simulate,
  type ChallengeSpec,
  type SimOptionsInput,
  type SimResult,
  type TraderProfileInput,
} from "@luxalgo/prop-firm-sim-core";
import {
  adaptFirm,
  type AdaptedChallenge,
  type DirectoryFirmRow,
} from "@luxalgo/prop-firm-sim-core/directory";
import { toolDefinitions, type ToolResult } from "@luxalgo/prop-firm-sim-mcp/dist/tools.js";
import { fetchDirectory, resolveFirm } from "@luxalgo/prop-firm-sim-mcp/dist/directory.js";

/* ------------------------------------------------------------------------ *
 * The six package tools, renamed to this repo's propfirms_ convention
 * ------------------------------------------------------------------------ */

/** Package-name -> local-name map for the tools this server exposes
 *  (analyze_portfolio_overlap is deliberately left out of the surface for
 *  now). Values follow the existing propfirms_* naming convention. */
const TOOL_RENAMES: Record<string, string> = {
  list_firms: "propfirms_list_simulatable",
  get_challenge_rules: "propfirms_challenge_rules",
  simulate_challenge: "propfirms_simulate",
  optimal_risk: "propfirms_optimal_risk",
  compare_challenges: "propfirms_compare",
  bootstrap_simulate: "propfirms_simulate_trades",
};

/** Every upstream name that must not surface here: the six renamed tools,
 *  plus analyze_portfolio_overlap (not exposed), whose mentions point at
 *  the result field that carries the same analysis instead. */
const REFERENCE_REWRITES: Record<string, string> = {
  ...TOOL_RENAMES,
  analyze_portfolio_overlap: "the attached structuredContent.portfolioOverlap analysis",
};

/** Rewrite sibling-tool references inside a description to the local
 *  names, so agents are pointed at tools that actually exist here. */
function rewriteToolReferences(description: string): string {
  let out = description;
  const names = Object.keys(REFERENCE_REWRITES).sort((a, b) => b.length - a.length);
  for (const name of names) {
    out = out.replace(new RegExp(`\\b${name}\\b`, "g"), REFERENCE_REWRITES[name]!);
  }
  return out;
}

/** Rewrite tool references inside a zod schema's field descriptions,
 *  recursively (wrappers, arrays, nested objects, unions), returning a new
 *  schema so the upstream definitions stay untouched. Descriptions are the
 *  only thing changed: agents read them in tools/list, and the upstream
 *  ones reference tool names that do not exist under those names here. */
function rewriteSchemaDescriptions<T extends z.ZodTypeAny>(schema: T): T {
  const def = { ...(schema._def as Record<string, unknown>) };
  if (typeof def.description === "string") {
    def.description = rewriteToolReferences(def.description);
  }
  if (def.innerType instanceof z.ZodType) {
    def.innerType = rewriteSchemaDescriptions(def.innerType); // optional/nullable/default
  }
  if (def.type instanceof z.ZodType) {
    def.type = rewriteSchemaDescriptions(def.type); // array element
  }
  if (def.schema instanceof z.ZodType) {
    def.schema = rewriteSchemaDescriptions(def.schema); // effects/refinements
  }
  if (Array.isArray(def.options)) {
    def.options = def.options.map((option: z.ZodTypeAny) => rewriteSchemaDescriptions(option)); // unions
  }
  if (typeof def.shape === "function") {
    const shape = (def.shape as () => Record<string, z.ZodTypeAny>)();
    const next = Object.fromEntries(
      Object.entries(shape).map(([key, field]) => [key, rewriteSchemaDescriptions(field)]),
    );
    def.shape = () => next;
  }
  return new (schema.constructor as new (d: unknown) => T)(def);
}

/** rewriteSchemaDescriptions over every field of a raw shape. */
function rewriteShapeDescriptions(
  shape: Record<string, z.ZodTypeAny>,
): Record<string, z.ZodTypeAny> {
  return Object.fromEntries(
    Object.entries(shape).map(([key, field]) => [key, rewriteSchemaDescriptions(field)]),
  );
}

/* ------------------------------------------------------------------------ *
 * Shared helpers for the two locally implemented tools
 * ------------------------------------------------------------------------ */

function ok(text: string, structuredContent: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function safely(fn: () => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (error) {
    return toolError(error instanceof Error ? error.message : String(error));
  }
}

function fmtPct(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

function fmtMoney(x: number, currency: string): string {
  return `${Math.round(x).toLocaleString("en-US")} ${currency.toUpperCase()}`;
}

const normalizeName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** One firm's simulatable challenge by id, or a self-correcting error. */
function requireAdaptedChallenge(firm: DirectoryFirmRow, challengeId: string): AdaptedChallenge {
  const adapted = adaptFirm(firm);
  const match = adapted.find((challenge) => challenge.challengeId === challengeId);
  if (!match) {
    const known = adapted.map((challenge) => challenge.challengeId).join(", ");
    throw new Error(
      `No simulatable challenge '${challengeId}' on '${firm.propfirmId}'. ` +
        (known ? `Simulatable challenges: ${known}.` : "This firm has no simulatable challenges."),
    );
  }
  return match;
}

/* Input fields shared with the package's tools — same units, same wording
   conventions (fractions vs percent units are the classic trap). */

const traderFields = {
  winRate: z
    .number()
    .min(0)
    .max(1)
    .describe(
      "Probability a trade is a winner, as a FRACTION in [0, 1] (0.55 = 55% winners) — NOT percent " +
        "units. The most impactful input: traders routinely overestimate it by a few points, which can " +
        "flip EV negative, so prefer measured stats over self-reported ones.",
    ),
  avgWinR: z
    .number()
    .positive()
    .describe(
      "Average winning trade in R-multiples, i.e. multiples of the amount risked per trade " +
        "(1.5 = winners average 1.5x the risk).",
    ),
  avgLossR: z
    .number()
    .positive()
    .optional()
    .describe(
      "Average losing trade in R, as a POSITIVE number. Default 1 (losers lose exactly the risked " +
        "amount, i.e. stops are honored). Raise above 1 to model slippage or blown stops.",
    ),
  winStdR: z
    .number()
    .min(0)
    .optional()
    .describe(
      "Standard deviation of winner sizes in R (0 = every winner is exactly avgWinR). Default 0. " +
        "Adding spread makes streak damage more realistic.",
    ),
  lossStdR: z
    .number()
    .min(0)
    .optional()
    .describe("Standard deviation of loser sizes in R (0 = every loser is exactly avgLossR). Default 0."),
  tradesPerDay: z
    .number()
    .positive()
    .describe(
      "Average trades per simulated trading day. More trades per day means more ways to hit the daily " +
        "loss limit within a single day.",
    ),
  tradesPerDayModel: z
    .enum(["fixed", "poisson"])
    .optional()
    .describe(
      "'fixed' (default): the same count every day. 'poisson': daily count drawn Poisson(tradesPerDay); " +
        "days can then have zero trades, which do not count as trading days.",
    ),
};

const riskModeField = z
  .enum(["percent-of-balance", "percent-of-initial", "fixed-amount"])
  .optional()
  .describe(
    "How riskValue is interpreted. 'percent-of-balance' (default): risk compounds with the current " +
      "balance. 'percent-of-initial': constant currency risk derived from the initial account size — how " +
      "most prop traders size, since loss limits are fixed in currency. 'fixed-amount': explicit currency " +
      "risked per 1R.",
  );

const riskValueField = z
  .number()
  .positive()
  .describe(
    "Risk per trade — the value of 1R. PERCENT UNITS for percent modes (0.5 = 0.5% risked per trade; a " +
      "typical prop range is 0.25-2), or a currency amount for 'fixed-amount'. NOT a fraction.",
  );

const simOptionFields = {
  seed: z
    .union([z.number().int(), z.string()])
    .optional()
    .describe(
      "RNG seed (integer or string). Default 42. Same inputs + seed reproduce byte-identical results — " +
        "include the seed when reporting so users can reproduce the numbers.",
    ),
  attemptCap: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      "Maximum challenge attempts per path before that path gives up. Default 25. Journey statistics " +
        "(expected attempts/cost, P(funded)) are censored at this cap.",
    ),
  simulateFunded: z
    .boolean()
    .optional()
    .describe(
      "Whether to simulate the funded stage (payouts, blowup risk) after passing. Default true — EV is " +
        "only meaningful with it on; set false to study the evaluation alone.",
    ),
  fundedHorizonDays: z
    .number()
    .int()
    .min(1)
    .max(2000)
    .optional()
    .describe(
      "Funded-stage horizon in trading days for the payout/EV simulation. Default 90 (about 4 calendar " +
        "months). EV scales with this choice — state it when reporting EV.",
    ),
};

/* ------------------------------------------------------------------------ *
 * propfirms_pass_rates — the site's published reference odds, reproduced
 * ------------------------------------------------------------------------ */

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

const PRECOMPUTED_SEED = 42;
const PRECOMPUTED_PATHS = 10_000;

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

function handlePassRates(input: unknown): Promise<ToolResult> {
  return safely(async () => {
    const args = passRatesSchema.parse(input);
    const rows = await fetchDirectory();
    // Throws readable errors listing what actually exists.
    const firm = resolveFirm(rows, args.firmId);
    const adaptedAll = args.challengeId
      ? [requireAdaptedChallenge(firm, args.challengeId)]
      : adaptFirm(firm);
    if (adaptedAll.length === 0) {
      return toolError(
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

/* ------------------------------------------------------------------------ *
 * propfirms_validate_strategy — screen one strategy across the directory
 * ------------------------------------------------------------------------ */

const VALIDATE_CHALLENGE_CAP = 40;
const VALIDATE_DEFAULT_PATHS = 5000;

const validateStrategySchema = z.object({
  winRate: traderFields.winRate.optional(),
  avgWinR: traderFields.avgWinR.optional(),
  avgLossR: traderFields.avgLossR,
  winStdR: traderFields.winStdR,
  lossStdR: traderFields.lossStdR,
  tradesPerDay: traderFields.tradesPerDay,
  tradesPerDayModel: traderFields.tradesPerDayModel,
  rSeries: z
    .array(z.number())
    .min(10)
    .optional()
    .describe(
      "The strategy's real trades as R-multiples in chronological order (P&L divided by amount risked; " +
        "+1.8 = won 1.8x risk, -1 = lost the risk). At least 10 trades, 100+ recommended. When given, " +
        "the screen uses the stationary block bootstrap (streaks preserved) instead of winRate/avgWinR.",
    ),
  rSeriesText: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The same series as pasted text (JSON, CSV, or whitespace separated, optional 'R' suffix). " +
        "Mutually exclusive with rSeries.",
    ),
  blockMeanLength: z
    .number()
    .positive()
    .optional()
    .describe("Bootstrap mean block length in trades. Default 5. Only used with rSeries/rSeriesText."),
  riskMode: riskModeField,
  riskValue: riskValueField,
  minPassPerAttempt: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "The pass bar as a FRACTION in [0, 1]: a challenge counts as passing when the simulated " +
        "per-attempt pass probability is at least this. Default 0.5. State the bar when relaying results.",
    ),
  requirePositiveEv: z
    .boolean()
    .optional()
    .describe(
      "Additionally require expected value (payouts minus all fees over the funded horizon) above zero. " +
        "Default false.",
    ),
  productType: z
    .enum(["futures", "cfd"])
    .optional()
    .describe("Restrict the screen to one instrument class."),
  firm: z
    .string()
    .min(1)
    .optional()
    .describe("Restrict to one firm by propfirmId or name (e.g. 'ftmo')."),
  accountSizeMin: z.number().positive().optional().describe("Only challenges with at least this account size."),
  accountSizeMax: z.number().positive().optional().describe("Only challenges with at most this account size."),
  priceMax: z.number().positive().optional().describe("Only challenges costing at most this."),
  seed: simOptionFields.seed,
  paths: z
    .number()
    .int()
    .min(100)
    .max(20_000)
    .optional()
    .describe(
      `Monte Carlo paths PER CHALLENGE. Default ${VALIDATE_DEFAULT_PATHS.toLocaleString("en-US")} here ` +
        "(one full simulation runs per challenge in scope, so this tool costs number-of-challenges times " +
        "one simulation); raise it to tighten confidence intervals on a narrowed scope.",
    ),
  attemptCap: simOptionFields.attemptCap,
  simulateFunded: simOptionFields.simulateFunded,
  fundedHorizonDays: simOptionFields.fundedHorizonDays,
});

interface ValidatedChallengeRow {
  firmId: string;
  firmName: string;
  challengeId: string;
  name: string;
  productType: string;
  accountSize: number;
  currency: string;
  price: number;
  passPerAttempt: number;
  passCiLow: number;
  passCiHigh: number;
  fundedProbability: number;
  expectedAttempts: number;
  expectedCost: number;
  evTotal: number;
  pEvPositive: number;
  meetsBar: boolean;
  flagIds: string[];
  inferredFields: string[];
}

function handleValidateStrategy(input: unknown): Promise<ToolResult> {
  return safely(async () => {
    const args = validateStrategySchema.parse(input);

    const hasSeries = args.rSeries !== undefined || args.rSeriesText !== undefined;
    const hasStats = args.winRate !== undefined || args.avgWinR !== undefined;
    if (args.rSeries !== undefined && args.rSeriesText !== undefined) {
      throw new Error("Provide either rSeries (numbers) or rSeriesText (pasted text), not both.");
    }
    if (hasSeries && hasStats) {
      throw new Error(
        "Provide ONE description of the strategy: real trades (rSeries/rSeriesText, preferred) or " +
          "summary stats (winRate + avgWinR), not both.",
      );
    }
    if (!hasSeries && (args.winRate === undefined || args.avgWinR === undefined)) {
      throw new Error(
        "No strategy given. Provide the real trades as rSeries/rSeriesText (at least 10 R-multiples), " +
          "or summary stats with both winRate and avgWinR.",
      );
    }

    const profile: TraderProfileInput = hasSeries
      ? ({
          kind: "bootstrap",
          rSeries: args.rSeries ?? parseRSeries(args.rSeriesText as string),
          blockMeanLength: args.blockMeanLength,
          tradesPerDay: args.tradesPerDay,
          tradesPerDayModel: args.tradesPerDayModel,
          risk: { mode: args.riskMode, value: args.riskValue },
        } as TraderProfileInput)
      : ({
          kind: "parametric",
          winRate: args.winRate as number,
          avgWinR: args.avgWinR as number,
          avgLossR: args.avgLossR,
          winStdR: args.winStdR,
          lossStdR: args.lossStdR,
          tradesPerDay: args.tradesPerDay,
          tradesPerDayModel: args.tradesPerDayModel,
          risk: { mode: args.riskMode, value: args.riskValue },
        } as TraderProfileInput);

    const rows = await fetchDirectory();
    const totalChallenges = rows.reduce((acc, firm) => acc + (firm.challenges?.length ?? 0), 0);
    const adaptedAll = rows.flatMap((firm) => adaptFirm(firm));
    const notSimulatable = totalChallenges - adaptedAll.length;

    const wantedFirm = args.firm !== undefined ? normalizeName(args.firm) : null;
    const parsedAll = adaptedAll.map((adapted) => ({
      adapted,
      spec: ChallengeSpecSchema.parse(adapted.spec),
    }));
    const inScope = parsedAll.filter(({ adapted, spec }) => {
      if (wantedFirm !== null) {
        const idMatch = normalizeName(adapted.propfirmId) === wantedFirm;
        const nameMatch = normalizeName(adapted.firmName).includes(wantedFirm);
        if (!idMatch && !nameMatch) return false;
      }
      if (args.productType !== undefined && adapted.productType !== args.productType) return false;
      if (args.accountSizeMin !== undefined && spec.accountSize < args.accountSizeMin) return false;
      if (args.accountSizeMax !== undefined && spec.accountSize > args.accountSizeMax) return false;
      if (args.priceMax !== undefined && spec.fees.price > args.priceMax) return false;
      return true;
    });

    if (inScope.length === 0) {
      return toolError(
        `No simulatable directory challenge matches the scope (${adaptedAll.length} simulatable in ` +
          "total). Loosen productType/accountSize/priceMax/firm, or check propfirms_list_simulatable " +
          "for what exists.",
      );
    }
    if (inScope.length > VALIDATE_CHALLENGE_CAP) {
      return toolError(
        `${inScope.length} challenges are in scope, above the per-call cap of ${VALIDATE_CHALLENGE_CAP} ` +
          "(one full simulation runs per challenge). Narrow the scope with productType, accountSizeMin/" +
          "accountSizeMax, priceMax, or firm; nothing is screened silently.",
      );
    }

    const minPass = args.minPassPerAttempt ?? 0.5;
    const requireEv = args.requirePositiveEv === true;
    const options: SimOptionsInput = {
      seed: args.seed,
      paths: args.paths ?? VALIDATE_DEFAULT_PATHS,
      attemptCap: args.attemptCap,
      simulateFunded: args.simulateFunded,
      fundedHorizonDays: args.fundedHorizonDays,
      includeHistograms: false,
    };

    let seedUsed: number | string = PRECOMPUTED_SEED;
    let pathsUsed = args.paths ?? VALIDATE_DEFAULT_PATHS;
    const evaluated: ValidatedChallengeRow[] = inScope.map(({ adapted, spec }) => {
      const result = simulate(adapted.spec, profile, options);
      seedUsed = result.meta.seed;
      pathsUsed = result.meta.paths;
      const pass = result.perAttempt.passProbability;
      const evTotal = result.ev.evTotal;
      return {
        firmId: adapted.propfirmId,
        firmName: adapted.firmName,
        challengeId: adapted.challengeId,
        name: adapted.challengeName,
        productType: adapted.productType,
        accountSize: spec.accountSize,
        currency: spec.currency,
        price: spec.fees.price,
        passPerAttempt: pass,
        passCiLow: result.perAttempt.passProbabilityCi.low,
        passCiHigh: result.perAttempt.passProbabilityCi.high,
        fundedProbability: result.journey.fundedProbability,
        expectedAttempts: result.journey.attempts.mean,
        expectedCost: result.journey.cost.mean,
        evTotal,
        pEvPositive: result.ev.pPositive,
        meetsBar: pass >= minPass && (!requireEv || evTotal > 0),
        flagIds: result.assumptions.flags.map((flag) => flag.id),
        inferredFields: adapted.inferredFields,
      };
    });

    const byPassDesc = (a: ValidatedChallengeRow, b: ValidatedChallengeRow) =>
      b.passPerAttempt - a.passPerAttempt || a.challengeId.localeCompare(b.challengeId);
    const passing = evaluated.filter((row) => row.meetsBar).sort(byPassDesc);
    const failing = evaluated.filter((row) => !row.meetsBar).sort(byPassDesc);

    const bar =
      `pass per attempt >= ${fmtPct(minPass, 0)}` + (requireEv ? " AND expected value above zero" : "");
    const rowLine = (row: ValidatedChallengeRow) =>
      `  - ${row.firmName}: ${row.name} [${row.firmId}/${row.challengeId}] ` +
      `(${fmtMoney(row.accountSize, row.currency)} ${row.productType}): ` +
      `pass/attempt ${fmtPct(row.passPerAttempt)} (95% CI ${fmtPct(row.passCiLow)}-${fmtPct(row.passCiHigh)}), ` +
      `P(funded) ${fmtPct(row.fundedProbability)}, expected cost ${fmtMoney(row.expectedCost, row.currency)}, ` +
      `EV ${fmtMoney(row.evTotal, row.currency)}` +
      (row.flagIds.length > 0 ? ` [flags: ${row.flagIds.join(", ")}]` : "") +
      (row.inferredFields.length > 0 ? ` [inferred: ${row.inferredFields.join(", ")}]` : "");

    const lines: string[] = [];
    lines.push(
      `Screened this strategy across ${evaluated.length} simulatable directory challenge(s): ` +
        `${passing.length} meet YOUR bar (${bar}) for these inputs. The bar and the inputs are the ` +
        "caller's; this is a screen of distributions, not a ranking or endorsement of any firm.",
    );
    if (passing.length > 0) {
      lines.push("Meets the bar (sorted by pass probability for these inputs):");
      for (const row of passing) lines.push(rowLine(row));
    }
    if (failing.length > 0) {
      lines.push(`Below the bar (${failing.length}):`);
      for (const row of failing) lines.push(rowLine(row));
    }
    if (notSimulatable > 0) {
      lines.push(
        `${notSimulatable} directory challenge(s) were EXCLUDED as not simulatable (rule text too ` +
          "ambiguous to encode honestly), not failed. propfirms_list_simulatable names them.",
      );
    }
    lines.push(
      "Challenges with assumption flags have optimistic numbers (flagged rules are not simulated); " +
        "weigh flags alongside the probabilities. Numbers move with risk sizing: re-run with a " +
        "different riskValue, or sweep one challenge with propfirms_optimal_risk.",
    );
    lines.push(
      `Seed ${String(seedUsed)}, ${pathsUsed.toLocaleString("en-US")} paths per challenge, ` +
        `engine v${ENGINE_VERSION}.`,
    );
    lines.push(DISCLAIMER);

    return ok(lines.join("\n"), {
      bar: { minPassPerAttempt: minPass, requirePositiveEv: requireEv },
      profileKind: hasSeries ? "bootstrap" : "parametric",
      passing,
      belowBar: failing,
      excludedNotSimulatable: notSimulatable,
      note: "A screen of distributions for the caller's inputs and bar; not a ranking or endorsement.",
      meta: { seed: seedUsed, paths: pathsUsed, engineVersion: ENGINE_VERSION },
      disclaimer: DISCLAIMER,
    });
  });
}

/* ------------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------------ */

export function registerSimTools(server: McpServer): void {
  for (const def of toolDefinitions) {
    const localName = TOOL_RENAMES[def.name];
    if (localName === undefined) continue;
    server.registerTool(
      localName,
      {
        title: def.title,
        description: rewriteToolReferences(def.description),
        inputSchema: rewriteShapeDescriptions(def.inputShape),
      },
      async (args: unknown): Promise<CallToolResult> => {
        const result = await def.handler(args);
        // Result prose may also point at sibling tools (e.g. list_firms
        // suggests get_challenge_rules) — rewrite those references too.
        // Structured content is data and passes through untouched.
        return {
          ...result,
          content: result.content.map((item) =>
            item.type === "text" ? { ...item, text: rewriteToolReferences(item.text) } : item,
          ),
        } as CallToolResult;
      },
    );
  }

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
        "authoritative for current rules (check lastVerified).",
      inputSchema: passRatesSchema.shape,
    },
    async (args: unknown): Promise<CallToolResult> => (await handlePassRates(args)) as CallToolResult,
  );

  server.registerTool(
    "propfirms_validate_strategy",
    {
      title: "Screen a strategy across all challenges",
      description:
        "Answer 'which challenges would MY strategy actually pass?' in one call: simulate the given " +
        "strategy through every simulatable challenge in the live directory (optionally scoped by " +
        "productType, account-size range, priceMax, or firm) and split the results by an explicit, " +
        "caller-stated bar. Describe the strategy EITHER as real trades (rSeries/rSeriesText " +
        "R-multiples, preferred: the stationary block bootstrap preserves streaks, which is what " +
        "breaches loss limits) OR as summary stats (winRate + avgWinR, optional spreads), plus " +
        "tradesPerDay and risk sizing (riskMode + riskValue). The bar is minPassPerAttempt (a fraction, " +
        "default 0.5) with optional requirePositiveEv; always state the bar when relaying results. " +
        "Returns per challenge: pass probability per attempt with 95% CI, P(funded), expected attempts " +
        "and total cost, EV over the funded horizon, P(EV>0), assumption flag ids, and which rule " +
        "semantics were inferred from listing text. HONESTY FRAME: this is a screen of distributions " +
        "for the caller's inputs and bar, NOT a ranking or endorsement; challenges whose rules cannot " +
        "be encoded honestly are excluded and counted, never guessed; flagged (unsimulated) rules make " +
        "numbers optimistic, so relay flags. One full simulation runs per challenge (default " +
        "5,000 paths each; results are deterministic per seed), and scopes above 40 challenges are " +
        "refused rather than silently truncated: narrow the scope instead. Numbers move with risk " +
        "sizing; sweep one challenge with propfirms_optimal_risk afterwards.",
      inputSchema: validateStrategySchema.shape,
    },
    async (args: unknown): Promise<CallToolResult> => (await handleValidateStrategy(args)) as CallToolResult,
  );
}

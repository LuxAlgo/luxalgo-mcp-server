/*
  propfirms_validate_strategy — one strategy screened across every
  simulatable directory challenge against an explicit, caller-stated bar.
  One full simulation runs per challenge in scope; scopes above the cap are
  refused rather than silently truncated.
*/
import { z } from "zod";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import {
  ChallengeSpecSchema,
  DISCLAIMER,
  ENGINE_VERSION,
  parseRSeries,
  simulate,
  type SimOptionsInput,
  type TraderProfileInput,
} from "@luxalgo/prop-firm-sim-core";
import { adaptFirm } from "@luxalgo/prop-firm-sim-core/directory";
import { fetchDirectory } from "@luxalgo/prop-firm-sim-mcp/directory";
import { fmtMoney, fmtPct } from "../../_shared/format.js";
import {
  PRECOMPUTED_SEED,
  normalizeName,
  ok,
  riskModeField,
  riskValueField,
  safely,
  simError,
  simOptionFields,
  traderFields,
} from "./shared.js";

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

function handleValidateStrategy(input: unknown): Promise<CallToolResult> {
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
      return simError(
        `No simulatable directory challenge matches the scope (${adaptedAll.length} simulatable in ` +
          "total). Loosen productType/accountSize/priceMax/firm, or check propfirms_list_simulatable " +
          "for what exists.",
      );
    }
    if (inScope.length > VALIDATE_CHALLENGE_CAP) {
      return simError(
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

export function registerValidateStrategyTool(server: McpServer): void {
  server.registerTool(
    "propfirms_validate_strategy",
    {
      title: "Screen a strategy across all challenges",
      annotations: { readOnlyHint: true, openWorldHint: true },
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
        "sizing; sweep one challenge with propfirms_optimal_risk afterwards. Fees and expected " +
        "costs use the directory's listed prices (live discounts are NOT applied); prices, firm " +
        "profiles, and current offers are directory data (propfirms_search_challenges, " +
        "propfirms_get, propfirms_search_offers).",
      inputSchema: validateStrategySchema,
    },
    (args: unknown) => handleValidateStrategy(args),
  );
}

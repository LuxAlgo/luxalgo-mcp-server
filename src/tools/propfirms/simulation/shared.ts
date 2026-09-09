/*
  Shared by the two locally implemented simulation tools (pass-rates.ts,
  validate-strategy.ts): the reference seed/path count the site publishes
  with, input field schemas that mirror the package tools' units and wording
  (fractions vs percent units are the classic trap), and directory helpers.
*/
import { z } from "zod";
import { adaptFirm, type AdaptedChallenge, type DirectoryFirmRow } from "@luxalgo/prop-firm-sim-core/directory";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { guarded, textError } from "../../_shared/result.js";

/** Prose result with a structured twin — the simulation tools' shape. */
export { ok } from "../../_shared/result.js";

/** Seed and path count luxalgo.com/prop-firms publishes its reference odds with. */
export const PRECOMPUTED_SEED = 42;
export const PRECOMPUTED_PATHS = 10_000;

/** Simulation failures are plain text (the engine's messages are already sentences). */
export const simError = textError;

/** Run a simulation handler, turning throws into plain-text tool errors. */
export function safely(fn: () => CallToolResult | Promise<CallToolResult>): Promise<CallToolResult> {
  return guarded(fn, textError);
}

export const normalizeName = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** One firm's simulatable challenge by id, or a self-correcting error. */
export function requireAdaptedChallenge(firm: DirectoryFirmRow, challengeId: string): AdaptedChallenge {
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

export const traderFields = {
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

export const riskModeField = z
  .enum(["percent-of-balance", "percent-of-initial", "fixed-amount"])
  .optional()
  .describe(
    "How riskValue is interpreted. 'percent-of-balance' (default): risk compounds with the current " +
      "balance. 'percent-of-initial': constant currency risk derived from the initial account size — how " +
      "most prop traders size, since loss limits are fixed in currency. 'fixed-amount': explicit currency " +
      "risked per 1R.",
  );

export const riskValueField = z
  .number()
  .positive()
  .describe(
    "Risk per trade — the value of 1R. PERCENT UNITS for percent modes (0.5 = 0.5% risked per trade; a " +
      "typical prop range is 0.25-2), or a currency amount for 'fixed-amount'. NOT a fraction.",
  );

export const simOptionFields = {
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

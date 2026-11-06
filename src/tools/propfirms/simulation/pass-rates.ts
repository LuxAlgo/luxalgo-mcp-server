/*
  propfirms_pass_rates — the reference-archetype odds luxalgo.com/prop-firms
  publishes, recomputed live from the directory's encoded rules with the same
  engine, seed and path count. Deterministic per ruleset and cached.
*/
import { z } from "zod";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type { Toolset } from "../../../auth/surface.js";
import { directoryCopy } from "./directory-copy.js";
import { rewriteSchemaDescriptions } from "./package-tools.js";
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
import { answersFrozen } from "../../_shared/surface.js";
import { challengeNameWithoutFirm, feeWords, fmtCurrency } from "./result-text.js";
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

/* Off the Claude address the overview is bounded (see firmOverview below). */
const OVERVIEW_PROGRAMS = 3;
const passRatesOpenSchema = passRatesSchema.extend({
  challengeId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "One challenge id, for its exact numbers. Omit for the firm overview: one account size per rules " +
        `program (up to ${OVERVIEW_PROGRAMS} programs), with every other simulatable challenge listed by id.`,
    ),
});

/** Deterministic per exact ruleset, so cache on the spec itself. */
const passRateCache = new Map<string, Record<string, unknown>>();

/**
 * The simulation never reads a challenge's id, name or citations, so two
 * challenges with the same encoded rules and fees (a firm's "Normal" and
 * "Swing" programs often are) share one run: the same numbers, computed once.
 */
const archetypeRuns = new Map<string, Record<string, unknown>[]>();

function runArchetypes(spec: ChallengeSpec): Record<string, unknown>[] {
  const { challengeId: _id, name: _name, sources: _sources, ...rules } = spec;
  const key = JSON.stringify(rules);
  const cached = archetypeRuns.get(key);
  if (cached !== undefined) return cached;
  const rows = TRADER_ARCHETYPES.map((archetype) =>
    archetypeSummary(
      simulate(spec, archetype.profile, {
        paths: PRECOMPUTED_PATHS,
        seed: PRECOMPUTED_SEED,
        includeHistograms: false,
      }),
      archetype,
    ),
  );
  archetypeRuns.set(key, rows);
  return rows;
}

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
    byArchetype: runArchetypes(spec),
  };
  passRateCache.set(key, entry);
  return entry;
}

function passRatesFor(adapted: Adapted): Record<string, unknown> {
  return challengePassRates(
    adapted.propfirmId,
    ChallengeSpecSchema.parse(adapted.spec),
    adapted.provenance,
    adapted.inferredFields,
  );
}

/** The cached entry plus its fees, for the text only (structured content keeps its shape). */
const feesById = new Map<string, unknown>();
function withFees(entry: Record<string, unknown>): Record<string, unknown> {
  return { ...entry, fees: feesById.get(String(entry.challengeId)) };
}

/*
  The firm overview (no challengeId, off the Claude address). Simulating every
  challenge of a large firm takes 10 to 20 seconds: FTMO has 14, three
  archetypes each, 10,000 paths per run. Most of them are the same rules
  program at different account sizes, and for those the rules are the same in
  percentage terms. So the overview computes one challenge per program (the
  size closest to 100K) for up to three programs, exactly as a challengeId
  call would, and lists every other challenge by id under its program
  without numbers. Nothing is estimated: every number shown is a full run.
*/
type Adapted = ReturnType<typeof adaptFirm>[number];

/** Rule amounts (targets, limits, payout caps) as a fraction of the account; everything size-free kept as is. */
function relativeToAccount(value: unknown, accountSize: number, key = ""): unknown {
  if (typeof value === "number" && (/amount$/i.test(key) || key === "winningDayMinProfit")) return value / accountSize;
  if (Array.isArray(value)) return value.map((entry) => relativeToAccount(entry, accountSize));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, entry]) => [k, relativeToAccount(entry, accountSize, k)]),
    );
  }
  return value;
}

/** Same signature = the same rules at another account size (fees and citations aside). */
function programSignature(adapted: Adapted): string {
  const spec = ChallengeSpecSchema.parse(adapted.spec);
  const { challengeId: _id, name: _name, accountSize, fees, sources: _sources, ...rules } = spec;
  return JSON.stringify({
    productType: adapted.productType,
    billing: fees.billing,
    refundableOnPass: fees.refundableOnPass,
    rules: relativeToAccount(rules, accountSize),
  });
}

/** "FTMO - Normal Challenge - 2-Steps 100K" → "Normal Challenge - 2-Steps". */
function programLabel(name: string, firmName: string): string {
  const label = challengeNameWithoutFirm(name.trim(), firmName)
    .replace(/[\s-]*\$?\d[\d,.]*\s*[kKmM]?\s*$/, "")
    .trim();
  return label.length > 0 ? label : name.trim();
}

type Program = { label: string; representative: Adapted; members: Adapted[] };

function firmPrograms(adapted: Adapted[]): Program[] {
  const bySignature = new Map<string, Adapted[]>();
  for (const challenge of adapted) {
    // The firm's own program name counts too: two programs can encode the same
    // simulated rules (e.g. differing only in news or weekend terms) and still
    // be different products.
    const signature = `${programLabel(challenge.challengeName, challenge.firmName)}\n${programSignature(challenge)}`;
    bySignature.set(signature, [...(bySignature.get(signature) ?? []), challenge]);
  }
  const distance = (challenge: Adapted) => Math.abs(Math.log((challenge.spec.accountSize as number) / 100_000));
  return [...bySignature.values()]
    .map((members) => {
      const sorted = [...members].sort(
        (a, b) => (a.spec.accountSize as number) - (b.spec.accountSize as number) || a.challengeId.localeCompare(b.challengeId),
      );
      const representative = [...sorted].sort(
        (a, b) => distance(a) - distance(b) || (b.spec.accountSize as number) - (a.spec.accountSize as number),
      )[0]!;
      return { label: programLabel(representative.challengeName, representative.firmName), representative, members: sorted };
    })
    .sort((a, b) => b.members.length - a.members.length || a.label.localeCompare(b.label));
}

function feeNote(challenge: Record<string, unknown>): string {
  const fees = challenge.fees as Parameters<typeof feeWords>[0] | undefined;
  return fees ? `; ${feeWords(fees, String(challenge.currency)).replace(/^Fee/, "fee")}` : "";
}

function openText(
  firmName: string,
  challenges: Record<string, unknown>[],
  overview: { programs: Record<string, unknown>[]; notComputed: number } | null,
): string {
  const lines: string[] = [];
  lines.push(
    `Reference pass rates for ${firmName}, computed live from the directory's encoded rules with the same ` +
      `engine, seed (${PRECOMPUTED_SEED}), path count (${PRECOMPUTED_PATHS.toLocaleString("en-US")}) and ` +
      "reference trader archetypes luxalgo.com/prop-firms uses. These are reference odds, not the user's own:",
  );
  for (const challenge of challenges) {
    const byArchetype = challenge.byArchetype as Record<string, unknown>[];
    lines.push(
      `${challengeNameWithoutFirm(String(challenge.name), firmName)} (${String(challenge.challengeId)}, ` +
        `${fmtCurrency(Number(challenge.accountSize), String(challenge.currency))}${feeNote(challenge)}): ` +
        byArchetype
          .map(
            (row) =>
              `${String(row.archetypeId)} ${Number(row.passPerAttemptPct).toFixed(1)}% per attempt ` +
              `(average cost across attempts ${fmtCurrency(Number(row.expectedCostUsd), String(challenge.currency))})`,
          )
          .join(" | "),
    );
    const inferred = challenge.inferredFields as string[];
    if (inferred.length > 0) {
      lines.push(`  Rules inferred from listing text (the firm's page is authoritative): ${inferred.join(", ")}.`);
    }
    if (challenge.lastVerified !== null) {
      lines.push(`  Rules last verified ${String(challenge.lastVerified)}.`);
    }
  }
  if (overview) {
    lines.push(
      `Firm overview: one account size per rules program, up to ${OVERVIEW_PROGRAMS} programs. Other sizes of a ` +
        "program have the same rules in percentage terms and their own fees; a challengeId gives any one's exact numbers.",
    );
    for (const program of overview.programs) {
      const others = (program.otherChallengeIds as string[]) ?? [];
      lines.push(
        `  ${String(program.program)}: ` +
          (program.computedChallengeId ? `computed ${String(program.computedChallengeId)}` : "not computed") +
          (others.length > 0 ? `; other sizes ${others.join(", ")}` : ""),
      );
    }
  }
  lines.push(
    "The archetypes span the realistic range, so the best case is not the base case. The user's own " +
      "statistics go through propfirms_simulate, or propfirms_simulate_trades with their real trades.",
  );
  lines.push(DISCLAIMER);
  return lines.join("\n");
}

function firmOverview(firm: Parameters<typeof adaptFirm>[0]): CallToolResult {
  const adapted = adaptFirm(firm);
  if (adapted.length === 0) {
    return simError(
      `No challenge of '${firm.name}' carries rule semantics the engine can adapt honestly. ` +
        "propfirms_simulate takes an inline `spec` instead.",
    );
  }
  for (const challenge of adapted) feesById.set(challenge.challengeId, ChallengeSpecSchema.parse(challenge.spec).fees);
  const programs = firmPrograms(adapted);
  const computed = programs.slice(0, OVERVIEW_PROGRAMS);
  const challenges = computed.map((program) => passRatesFor(program.representative));
  const programRows = programs.map((program, index) => ({
    program: program.label,
    ...(index < OVERVIEW_PROGRAMS ? { computedChallengeId: program.representative.challengeId } : {}),
    otherChallengeIds: program.members
      .filter((member) => index >= OVERVIEW_PROGRAMS || member !== program.representative)
      .map((member) => member.challengeId),
  }));
  const notComputed = adapted.length - computed.length;
  const firmName = adapted[0]!.firmName;
  return ok(openText(firmName, challenges.map(withFees), { programs: programRows, notComputed }), {
    firmId: adapted[0]!.propfirmId,
    firmName,
    challenges,
    overview: {
      programs: programRows,
      simulatableChallenges: adapted.length,
      computedChallenges: computed.length,
      note:
        "One account size per rules program; other sizes have the same rules in percentage terms and their own " +
        "fees. Pass challengeId for any one's exact numbers.",
    },
    seed: PRECOMPUTED_SEED,
    paths: PRECOMPUTED_PATHS,
    engineVersion: ENGINE_VERSION,
    disclaimer: DISCLAIMER,
  });
}

function handlePassRates(input: unknown, open: boolean): Promise<CallToolResult> {
  return safely(async () => {
    const args = passRatesSchema.parse(input);
    const rows = await fetchDirectory();
    // Throws readable errors listing what actually exists.
    const firm = resolveFirm(rows, args.firmId);
    if (open && !args.challengeId) return firmOverview(firm);
    const adaptedAll = args.challengeId
      ? [requireAdaptedChallenge(firm, args.challengeId)]
      : adaptFirm(firm);
    for (const challenge of adaptedAll) feesById.set(challenge.challengeId, ChallengeSpecSchema.parse(challenge.spec).fees);
    if (adaptedAll.length === 0) {
      return simError(
        `No challenge of '${firm.name}' carries rule semantics the engine can adapt honestly. ` +
          "Simulate via an inline `spec` with propfirms_simulate instead.",
      );
    }

    const challenges = adaptedAll.map((adapted) => passRatesFor(adapted));
    const firmName = adaptedAll[0]!.firmName;
    const propfirmId = adaptedAll[0]!.propfirmId;
    if (open) {
      return ok(openText(firmName, challenges.map(withFees), null), {
        firmId: propfirmId,
        firmName,
        challenges,
        seed: PRECOMPUTED_SEED,
        paths: PRECOMPUTED_PATHS,
        engineVersion: ENGINE_VERSION,
        disclaimer: DISCLAIMER,
      });
    }

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

export function registerPassRatesTool(server: McpServer, toolset: Toolset): void {
  const open = !answersFrozen();
  server.registerTool(
    "propfirms_pass_rates",
    {
      title: "Reference pass rates per archetype",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description: (toolset === "directory" ? directoryCopy : (text: string) => text)(
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
        (toolset === "directory"
          ? "listed challenge prices; full firm profiles are directory data (propfirms_get)."
          : "listed challenge prices; full firm profiles and live offers are directory data " +
            "(propfirms_get, propfirms_search_offers).") +
        (open
          ? " Without challengeId the result is a firm overview: one account size per rules program (up to " +
            `${OVERVIEW_PROGRAMS} programs) with every other simulatable challenge listed by id; a challengeId ` +
            "gives that challenge's exact numbers."
          : ""),
      ),
      inputSchema: (() => {
        const schema = open ? passRatesOpenSchema : passRatesSchema;
        return toolset === "directory" ? rewriteSchemaDescriptions(schema, directoryCopy) : schema;
      })(),
    },
    (args: unknown) => handlePassRates(args, open),
  );
}

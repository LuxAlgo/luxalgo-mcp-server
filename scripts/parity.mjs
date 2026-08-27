/*
  Parity harness for the simulator tools: proves the renamed wrappers behave
  exactly like the upstream @luxalgo/prop-firm-sim-mcp handlers (identical
  structured content; text identical modulo the deliberate tool-name
  rewrite), and that the two locally implemented tools (pass_rates,
  validate_strategy) reproduce the raw engine's numbers bit-for-bit.

  Run after every @luxalgo/prop-firm-sim-* version bump: npm run test:parity
*/
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { toolDefinitions } from "@luxalgo/prop-firm-sim-mcp/dist/tools.js";
import { fetchDirectory, resolveFirm } from "@luxalgo/prop-firm-sim-mcp/dist/directory.js";
import { ChallengeSpecSchema, simulate } from "@luxalgo/prop-firm-sim-core";
import { adaptFirm } from "@luxalgo/prop-firm-sim-core/directory";

const upstream = Object.fromEntries(toolDefinitions.map((t) => [t.name, t]));

// Must mirror TOOL_RENAMES in src/lib/sim-tools.ts.
const RENAMES = {
  list_firms: "propfirms_list_simulatable",
  get_challenge_rules: "propfirms_challenge_rules",
  simulate_challenge: "propfirms_simulate",
  optimal_risk: "propfirms_optimal_risk",
  compare_challenges: "propfirms_compare",
  bootstrap_simulate: "propfirms_simulate_trades",
};

function rewrite(text) {
  let out = text;
  for (const name of Object.keys(RENAMES).sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`\\b${name}\\b`, "g"), RENAMES[name]);
  }
  return out;
}

let failures = 0;
function check(label, condition, detail = "") {
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failures++;
  console.log(`${status}  ${label}${detail ? ` — ${detail}` : ""}`);
}

const client = new Client({ name: "parity", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] }),
);

async function ours(name, args) {
  const result = await client.callTool({ name, arguments: args });
  return {
    text: result.content?.[0]?.text ?? "",
    structured: result.structuredContent ?? null,
    isError: result.isError === true,
  };
}

async function theirs(name, args) {
  const result = await upstream[name].handler(args);
  return {
    text: result.content?.[0]?.text ?? "",
    structured: result.structuredContent ?? null,
    isError: result.isError === true,
  };
}

// Fixture: a real simulatable firm/challenge pair, resolved once.
const firms = await fetchDirectory();
const firm = resolveFirm(firms, "alpha-capital-group");
const adapted = adaptFirm(firm);
const challengeId = adapted[0].challengeId;
const trader = { winRate: 0.48, avgWinR: 1.6, tradesPerDay: 4, riskValue: 1 };
const rSeries = Array.from({ length: 60 }, (_, i) => (i % 5 < 2 ? 1.8 : i % 5 === 4 ? 2.2 : -1));

const cases = [
  ["list_firms", {}],
  ["get_challenge_rules", { firmId: firm.propfirmId, challengeId }],
  ["simulate_challenge", { firmId: firm.propfirmId, challengeId, ...trader, paths: 2000 }],
  [
    "optimal_risk",
    {
      firmId: firm.propfirmId,
      challengeId,
      winRate: trader.winRate,
      avgWinR: trader.avgWinR,
      tradesPerDay: trader.tradesPerDay,
      min: 0.5,
      max: 1.5,
      step: 0.5,
      paths: 1000,
    },
  ],
  [
    "compare_challenges",
    {
      challenges: adapted.slice(0, 2).map((c) => ({ firmId: firm.propfirmId, challengeId: c.challengeId })),
      ...trader,
      paths: 1000,
    },
  ],
  [
    "bootstrap_simulate",
    { firmId: firm.propfirmId, challengeId, rSeries, tradesPerDay: 4, riskValue: 1, paths: 1000 },
  ],
];

const bareNames = new RegExp(`\\b(${Object.keys(RENAMES).join("|")})\\b`);

for (const [upstreamName, args] of cases) {
  const localName = RENAMES[upstreamName];
  const [a, b] = await Promise.all([ours(localName, args), theirs(upstreamName, args)]);
  const structuredEqual = JSON.stringify(a.structured) === JSON.stringify(b.structured);
  const textEqual = a.text === rewrite(b.text);
  check(
    `${localName} === ${upstreamName} (identical args)`,
    a.isError === b.isError && structuredEqual && textEqual && !bareNames.test(a.text),
    structuredEqual && textEqual
      ? `${a.text.length} chars, structured ${JSON.stringify(a.structured)?.length ?? 0} B`
      : `text ${textEqual}, structured ${structuredEqual}, isError ${a.isError}/${b.isError}`,
  );
}

// propfirms_pass_rates vs the raw engine with the same archetype profile.
const spec = ChallengeSpecSchema.parse(adapted[0].spec);
const engineRef = simulate(
  spec,
  {
    kind: "parametric",
    winRate: 0.48,
    avgWinR: 1.6,
    avgLossR: 1,
    tradesPerDay: 4,
    tradesPerDayModel: "poisson",
    risk: { mode: "percent-of-initial", value: 0.75 },
  },
  { paths: 10_000, seed: 42, includeHistograms: false },
);
const rates = await ours("propfirms_pass_rates", { firmId: firm.propfirmId, challengeId });
const consistent = rates.structured.challenges[0].byArchetype.find((a) => a.archetypeId === "consistent");
check(
  "propfirms_pass_rates('consistent') reproduces the raw engine number",
  Math.abs(consistent.passPerAttemptPct - engineRef.perAttempt.passProbability * 100) < 1e-9,
  `tool ${consistent.passPerAttemptPct} vs engine ${engineRef.perAttempt.passProbability * 100}`,
);

// propfirms_validate_strategy row vs a direct engine run, same seed/paths.
const screened = await ours("propfirms_validate_strategy", {
  winRate: trader.winRate,
  avgWinR: trader.avgWinR,
  tradesPerDay: trader.tradesPerDay,
  riskValue: 1,
  firm: firm.propfirmId,
  paths: 2000,
});
const allRows = [...screened.structured.passing, ...screened.structured.belowBar];
const row = allRows.find((r) => r.challengeId === challengeId);
const engineRow = simulate(
  adapted[0].spec,
  {
    kind: "parametric",
    winRate: trader.winRate,
    avgWinR: trader.avgWinR,
    tradesPerDay: trader.tradesPerDay,
    risk: { mode: undefined, value: 1 },
  },
  { paths: 2000, seed: 42, includeHistograms: false },
);
check(
  "propfirms_validate_strategy row reproduces the raw engine number",
  row !== undefined && Math.abs(row.passPerAttempt - engineRow.perAttempt.passProbability) < 1e-12,
  `tool ${row?.passPerAttempt} vs engine ${engineRow.perAttempt.passProbability}`,
);

// No stale (unrenamed) tool names may leak from any description.
const { tools } = await client.listTools();
const leaky = tools.filter((t) => bareNames.test(t.description ?? ""));
check(
  "no unrenamed upstream tool names leak from any description",
  leaky.length === 0,
  leaky.map((t) => t.name).join(", ") || "all descriptions clean",
);

await client.close();
console.log(`\n${failures === 0 ? "Parity holds." : `${failures} parity check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);

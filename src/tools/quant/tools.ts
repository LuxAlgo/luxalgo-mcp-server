/*
  Quant, our coding agent, for the signed-in member's AI assistant: write and
  check Pine Script®, find the member's saved scripts, and plan, start, stop
  and follow backtest loops (Quant writing and backtesting strategy versions
  until enough of them meet the plan's criteria).

  A script Quant writes here is kept in the member's LuxAlgo account as one of
  their Quant scripts. Planning and starting a loop return ids, never
  strategies: a loop runs for minutes to hours. What it found is read
  afterwards: quant_get_backtest_loop_info lists a loop's strategies by id,
  best first, and quant_get_backtest_loop_strategy reads one with its code
  and each market's backtest. "What was the best strategy of my latest
  loop?" is list, info, strategy.

  Every tool is protected, and every one relays to the LuxAlgo app
  (/api/agents/quant/*, api.ts): the app runs Quant, meters the member's
  Quant usage, and decides what their plan allows. Nothing about plans,
  usage or permissions is decided here (docs/auth.md §1).

  Three tools spend the member's Quant usage, and say so in their
  descriptions: quant_generate_pine_script, quant_plan_backtest_loop (one
  planning call) and quant_start_backtest_loop, which starts a run that keeps
  spending until it ends or quant_stop_backtest_loop stops it. Starting is
  the one tool marked destructive, so MCP hosts ask the member before it runs.

  Results are plain words plus compact structured content.

  quant_generate_pine_script can also put the script it wrote on the chart
  the member has open in Vela (add_to_chart, off by default). That is the
  chart tools' own add (tools/vela): once the script passes and is saved, the
  app is asked to add that saved script by its id, so no source goes to the
  chart route and every rule of an add holds (the member's own script, their
  plan's tools per chart, a change queued while Vela is not on screen). The
  option is offered only where the chart tools are listed.
*/
import { z } from "zod";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { registerProtectedTool } from "../../auth/protected-tool.js";
import type { AuthRuntime } from "../../auth/runtime.js";
import { AppApiError, AppAuthError, AppPermissionError } from "../../platform/app-client.js";
import { errorMessage, ok, textError } from "../_shared/result.js";
import { velaChartListedHere } from "../vela/index.js";
import { OPEN_VELA, sendChartCommand } from "../vela/tools.js";
import {
  generatePineScript,
  getBacktestLoop,
  getBacktestLoopStrategy,
  getUserScript,
  lintPineScript,
  listBacktestLoops,
  planBacktestLoop,
  searchUserScripts,
  startBacktestLoop,
  stopBacktestLoop,
  type LoopCriterion,
  type LoopInfo,
  type LoopPlan,
  type LoopStatus,
  type LoopStrategy,
  type LoopStrategyRef,
  type LoopStrategyWindow,
  type LoopSummary,
  type PineDiagnostic,
  type UserScriptSummary,
} from "./api.js";

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
/** Runs Quant on the member's usage; changes nothing they keep. */
const SPENDS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
/** Starts a run that keeps spending the member's Quant usage: hosts that honour annotations ask the member first. */
const START = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;
const STOP = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const USAGE = "It uses the member's Quant usage on their LuxAlgo plan, metered by the LuxAlgo app.";
const NOT_OPEN = "Quant from an AI assistant is not open on this LuxAlgo account yet (the LuxAlgo app answered 404).";
const LOOP_IS =
  "A backtest loop is an autonomous run in which Quant, our coding agent, writes and backtests Pine Script® strategy versions until enough of them meet the plan's criteria.";
const READ_RESULTS =
  "To read what a loop found, call quant_get_backtest_loop_info for its strategies' ids (best first) and quant_get_backtest_loop_strategy for one strategy's code and backtests.";
const CHART_IN_VELA =
  "The member puts a strategy on a chart, compares them and resumes a loop in Vela, in the loop's Loop Report (report_url).";
const HISTORY_ONLY = "Backtests are history under the plan's assumptions, never a prediction or trading advice.";

/** Request sizes the app accepts, in characters. */
const PROMPT_CHARS = 20_000;
const CODE_CHARS = 200_000;

/**
 * How long one generation or planning call may take, in seconds. The hosted
 * entries answer within their function's time limit (60 s), so the default
 * stays under it; a self-hosted server without that limit can give Quant more
 * with LUXALGO_QUANT_SECONDS (15 to 240).
 */
function timeBudgetSeconds(): number {
  const asked = Number(process.env.LUXALGO_QUANT_SECONDS);
  return Number.isFinite(asked) && asked > 0 ? Math.min(240, Math.max(15, Math.round(asked))) : 45;
}

/** A hosted call answers inside its function's 60 s limit; what is left of it after Quant wrote the script is the chart's. */
const HOSTED_ANSWER_MS = 56_000;
/** The longest the chart is waited for: what its own tools take at most (a tab that starts listening, then the add). */
const CHART_WAIT_MS = 45_000;
/** With less than this left, the add is not started: it would be cut off before it could answer. */
const CHART_MIN_MS = 6_000;

type OnChart = {
  /** added, updated (a new version of a script that was on the chart), queued, not_added, unknown or skipped. */
  status: "added" | "updated" | "queued" | "not_added" | "unknown" | "skipped";
  words: string;
  name?: string;
};

/**
 * Put the saved script on the chart the member has open in Vela, through the chart
 * tools' own add: by its id, never its source. `startedAt` is when the tool call began.
 */
async function putOnChart(scriptId: string, startedAt: number): Promise<OnChart> {
  const byHand = `call vela_add_indicator with script_id ${scriptId}`;
  const left = process.env.VERCEL_ENV ? HOSTED_ANSWER_MS - (Date.now() - startedAt) : CHART_WAIT_MS;
  if (left < CHART_MIN_MS) {
    return { status: "skipped", words: `There was no time left in this call to put it on the member's Vela chart: ${byHand}.` };
  }
  const sending = sendChartCommand({ op: "add_indicator", indicator: { script: scriptId, update: true } });
  // Still running when this stops waiting: its outcome is then nobody's to read.
  sending.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), Math.min(left, CHART_WAIT_MS));
  });
  const unknown: OnChart = {
    status: "unknown",
    words: `Putting it on the member's Vela chart did not finish in time, so it is not known whether it is there: read the chart with vela_read_chart, and if it is not, ${byHand}.`,
  };
  try {
    const answer = await Promise.race([sending, late]);
    if (answer === "late") return unknown;
    switch (answer.status) {
      case "ok": {
        const name = answer.indicatorAdded?.name;
        return answer.indicatorAdded?.updated
          ? { status: "updated", words: "It was on the member's Vela chart already, which now runs this version.", ...(name ? { name } : {}) }
          : { status: "added", words: `It is on the member's open Vela chart now${name ? `, as ${name}` : ""}; they saw it appear.`, ...(name ? { name } : {}) };
      }
      case "queued":
        return {
          status: "queued",
          words: `It is queued for the member's Vela chart, not on it yet: no Vela tab of theirs is on screen right now, and it is added the moment they look at Vela again, within 10 minutes. Tell them to open Vela at ${OPEN_VELA}.`,
        };
      case "failed":
        return { status: "not_added", words: `It was not put on the member's Vela chart: ${answer.error}` };
      default:
        return unknown;
    }
  } catch (error) {
    if (error instanceof AppAuthError || error instanceof AppPermissionError) throw error;
    if (error instanceof AppApiError && error.status === 404) {
      return { status: "not_added", words: "Putting a script on the member's Vela chart is not available on this account yet; it is saved, and they can add it from their scripts in Vela." };
    }
    return { status: "not_added", words: `It could not be put on the member's Vela chart (${errorMessage(error)}). To try again, ${byHand}.` };
  } finally {
    clearTimeout(timer);
  }
}

const loopIdInput = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .describe("The loop's id, from quant_start_backtest_loop or quant_list_backtest_loops.");

// ── words ───────────────────────────────────────────────────────────────────

const num = (n: number | null | undefined, digits = 2): string =>
  n === null || n === undefined ? "unknown" : n.toLocaleString("en-US", { maximumFractionDigits: digits });

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** Bar size in words: 15 → "15 minute", 240 → "4 hour", 1440 → "daily". */
function timeframeWords(minutes: number): string {
  if (minutes === 1440) return "daily";
  if (minutes === 10080) return "weekly";
  if (minutes > 60 && minutes % 1440 === 0) return `${minutes / 1440} day`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} hour`;
  return `${minutes} minute`;
}

const day = (ms: number): string => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "unknown");

function criterionWords({ metric, min, max }: LoopCriterion): string {
  if (min !== null && max !== null) return `${metric} from ${num(min)} to ${num(max)}`;
  if (min !== null) return `${metric} at least ${num(min)}`;
  if (max !== null) return `${metric} at most ${num(max)}`;
  return metric;
}

/** A plan in sentences: one per market, then the money management and the limits. */
function planWords(plan: LoopPlan): string {
  const markets = plan.legs.map((leg) => {
    const held = leg.window.out_of_sample_pct > 0 ? `, ${num(leg.window.out_of_sample_pct)}% of it held out` : "";
    const side = leg.side === "all" ? "long and short" : `${leg.side} only`;
    const criteria = leg.criteria.length > 0 ? leg.criteria.map(criterionWords).join(", ") : "judged by its challenge";
    return `${leg.ticker} on ${timeframeWords(leg.timeframe)} bars, ${day(leg.window.from)} to ${day(leg.window.to)}${held}, ${side}: ${criteria}`;
  });
  const { method, value } = plan.capital.order_size;
  const size =
    method === "percent_equity"
      ? `${num(value)}% of equity`
      : method === "base_currency"
        ? `$${num(value)}`
        : method === "quantity"
          ? `${num(value)} units`
          : `${num(value)} (${method.replaceAll("_", " ")})`;
  return (
    `${plural(plan.legs.length, "market")}: ${markets.join("; ")}. ` +
    `Starting capital $${num(plan.capital.initial_capital, 0)}, order size ${size}. ` +
    `It looks for ${plural(plan.strategies_required, "strategy that passes", "strategies that pass")} every market, for up to ${plural(plan.time_limit_minutes, "minute")}.`
  );
}

/** A status in a few words that read after "<markets>:" and inside "already ended (…)". */
const STATUS_WORDS: Record<LoopStatus, string> = {
  running: "running",
  paused_budget: "waiting for more Quant usage",
  succeeded: "finished, it found what the plan asked for",
  timed_out: "ended at its time limit",
  stuck: "ended early, its strategies stopped improving",
  cancelled: "stopped",
  failed: "failed",
};

/** Still going: running, or waiting for the member's usage to carry on. */
const isGoing = (status: LoopStatus): boolean => status === "running" || status === "paused_budget";

const statusWords = (status: LoopStatus): string => STATUS_WORDS[status] ?? status;

function loopWords(loop: LoopSummary): string {
  const markets = loop.markets.map((market) => `${market.ticker} ${timeframeWords(market.timeframe)}`).join(", ");
  return `${markets || "no markets"}: ${statusWords(loop.status)}, ${loop.strategiesFound} of ${loop.strategiesRequired} found in ${plural(loop.attempts, "attempt")}`;
}

function diagnosticWords(diagnostic: PineDiagnostic): string {
  const where = diagnostic.line === undefined ? "" : `line ${diagnostic.line}${diagnostic.column === undefined ? "" : `:${diagnostic.column}`} `;
  return `${where}${diagnostic.code}: ${diagnostic.message}`;
}

/** Up to ten findings, one a line; the rest counted. */
function diagnosticLines(diagnostics: PineDiagnostic[]): string {
  const shown = diagnostics.slice(0, 10).map((diagnostic) => `- ${diagnosticWords(diagnostic)}`);
  const more = diagnostics.length - shown.length;
  return [...shown, ...(more > 0 ? [`- and ${more} more`] : [])].join("\n");
}

// ── structured output (snake case, like the rest of this server's results) ──

const scriptOut = (script: UserScriptSummary) => ({
  id: script.id,
  name: script.name,
  type: script.type,
  origin: script.origin,
  ...(script.description ? { description: script.description } : {}),
  created_at: script.createdAt,
  updated_at: script.updatedAt,
});

const loopOut = (loop: LoopSummary) => ({
  id: loop.id,
  status: loop.status,
  active: loop.active,
  markets: loop.markets,
  strategies_found: loop.strategiesFound,
  strategies_required: loop.strategiesRequired,
  attempts: loop.attempts,
  active_seconds: loop.activeSeconds,
  time_limit_seconds: loop.timeLimitSeconds,
  created_at: loop.createdAt,
  finished_at: loop.finishedAt,
  report_url: loop.reportUrl,
});

const strategyRefOut = (strategy: LoopStrategyRef) => ({
  id: strategy.id,
  attempt: strategy.attempt,
  meets_every_criterion: strategy.passed,
  score: strategy.score,
  handed_back: strategy.handedBack,
  ...(strategy.scriptId ? { script_id: strategy.scriptId } : {}),
  ...(strategy.description ? { description: strategy.description } : {}),
});

const loopInfoOut = (loop: LoopInfo) => ({
  ...loopOut(loop),
  ...(loop.statusReason ? { status_reason: loop.statusReason } : {}),
  ...(loop.summary ? { summary: loop.summary } : {}),
  // An app that does not list strategies yet answers without them.
  best_strategy_id: loop.bestStrategyId ?? null,
  strategies: (loop.strategies ?? []).map(strategyRefOut),
});

const windowOut = (window: LoopStrategyWindow) => ({
  passed: window.passed,
  criteria: window.criteria.map((criterion) => ({
    metric: criterion.metric,
    min: criterion.min,
    max: criterion.max,
    value: criterion.value,
    passed: criterion.passed,
    ...(criterion.detail ? { detail: criterion.detail } : {}),
  })),
  ...(window.problems.length > 0 ? { problems: window.problems } : {}),
  metrics: window.metrics,
  backtest: window.backtest && {
    from: window.backtest.from,
    to: window.backtest.to,
    bars: window.backtest.bars,
    initial_capital: window.backtest.initialCapital,
    net_profit: window.backtest.netProfit,
    gross_profit: window.backtest.grossProfit,
    gross_loss: window.backtest.grossLoss,
    open_profit: window.backtest.openProfit,
    cagr_pct: window.backtest.cagrPct,
    max_drawdown: window.backtest.maxDrawdown,
    max_drawdown_pct: window.backtest.maxDrawdownPct,
    max_runup: window.backtest.maxRunup,
    max_runup_pct: window.backtest.maxRunupPct,
    sharpe_ratio: window.backtest.sharpeRatio,
    sortino_ratio: window.backtest.sortinoRatio,
    buy_and_hold_pnl: window.backtest.buyAndHoldPnl,
    buy_and_hold_pct: window.backtest.buyAndHoldPct,
    strategy_outperformance: window.backtest.strategyOutperformance,
  },
});

const strategyOut = (strategy: LoopStrategy) => ({
  id: strategy.id,
  loop_id: strategy.loopId,
  attempt: strategy.attempt,
  meets_every_criterion: strategy.passed,
  outcome: strategy.outcome,
  score: strategy.score,
  ...(strategy.family ? { family: strategy.family } : {}),
  ...(strategy.description ? { description: strategy.description } : {}),
  ...(strategy.notes ? { notes: strategy.notes } : {}),
  ...(strategy.behavior ? { behavior: strategy.behavior } : {}),
  handed_back: strategy.handedBack,
  ...(strategy.scriptId ? { script_id: strategy.scriptId } : {}),
  markets: strategy.markets.map((market) => ({
    ticker: market.ticker,
    timeframe: market.timeframe,
    in_sample: windowOut(market.inSample),
    out_of_sample: market.outOfSample ? windowOut(market.outOfSample) : null,
  })),
  code: strategy.code,
  report_url: strategy.reportUrl,
});

/** What a loop has found so far, in a sentence that names its best strategy. */
function foundWords(loop: LoopInfo): string {
  // An app that does not list strategies yet answers without them: say nothing rather than "none".
  if (!loop.strategies) return "";
  const best = loop.strategies[0];
  if (!best) return " No attempt has reached a backtest yet, so it has no strategy to read.";
  const standing = best.passed
    ? "meets every criterion"
    : `is the closest so far and does not meet every criterion (score ${best.score} of 100 in sample)`;
  return ` Its best strategy is ${best.id} (attempt ${best.attempt}), which ${standing}; read it with quant_get_backtest_loop_strategy.`;
}

/** One window's headline numbers in a clause: what a trader asks about first. */
function windowWords(window: LoopStrategyWindow): string {
  const metric = (name: string) => window.metrics?.[name] ?? null;
  // A loss reads "-$800", not "$-800".
  const money = (amount: number) => `${amount < 0 ? "-" : ""}$${num(Math.abs(amount), 0)}`;
  const facts = [
    metric("net_profit_ccy") === null ? null : `net profit ${money(metric("net_profit_ccy") ?? 0)}`,
    metric("profit_factor") === null ? null : `profit factor ${num(metric("profit_factor"))}`,
    metric("closed_trades") === null ? null : plural(metric("closed_trades") ?? 0, "trade"),
    metric("win_rate_pct") === null ? null : `win rate ${num(metric("win_rate_pct"), 1)}%`,
    metric("max_drawdown_pct") === null ? null : `max drawdown ${num(metric("max_drawdown_pct"), 1)}%`,
  ].filter((fact): fact is string => fact !== null);
  const failed = window.criteria.filter((criterion) => !criterion.passed).map((criterion) => criterion.metric);
  const verdict = window.passed
    ? "meets its criteria"
    : `does not meet its criteria${failed.length > 0 ? ` (${failed.join(", ")})` : ""}`;
  return `${facts.length > 0 ? `${facts.join(", ")}; ` : ""}${verdict}`;
}

/** A strategy in sentences: the verdict, what it does, and each market in sample and held out. */
function strategyWords(strategy: LoopStrategy): string {
  const verdict = strategy.passed
    ? "it meets every criterion on every market, held-out data included"
    : `it does not meet every criterion${strategy.score === null ? "" : ` (score ${strategy.score} of 100 in sample)`}`;
  const markets = strategy.markets.map((market) => {
    const name = `${market.ticker}${market.timeframe === null ? "" : ` ${timeframeWords(market.timeframe)}`}`;
    const held = market.outOfSample ? ` Held out: ${windowWords(market.outOfSample)}.` : " No data was held out.";
    return `${name}. In sample: ${windowWords(market.inSample)}.${held}`;
  });
  return (
    `Strategy ${strategy.id}, attempt ${strategy.attempt} of loop ${strategy.loopId}: ${verdict}.` +
    `${strategy.description ? ` ${strategy.description}` : ""}` +
    `${strategy.behavior ? ` How it trades: ${strategy.behavior}.` : ""}` +
    `\n${markets.join("\n")}`
  );
}

/** The app's refusals in words; sign-in and plan answers always go up to the auth wrapper. */
function failure(error: unknown, what: string): CallToolResult {
  if (error instanceof AppAuthError || error instanceof AppPermissionError) throw error;
  if (error instanceof AppApiError && error.status === 404 && /^Not available$/i.test(error.message)) {
    return textError(`${what}: ${NOT_OPEN}`);
  }
  return textError(`${what}: ${errorMessage(error)}`);
}

// ── registration ────────────────────────────────────────────────────────────

export function registerQuantTools(server: McpServer, runtime: AuthRuntime) {
  // Offered only where the chart tools are listed, so every other address keeps this tool's definition as it is.
  const withChart = velaChartListedHere();
  const onChartWords = withChart
    ? " With `add_to_chart` (off by default), a script that passes is also put on the chart the member has open right now in Vela, the one they used last, where they see it appear and run; a changed script that was on that chart already runs its new version in place. Set it only when the member asked to see it on their chart."
    : "";
  registerProtectedTool(
    server,
    runtime,
    "quant_generate_pine_script",
    {
      title: "Write Pine Script® with Quant",
      description: `Has Quant, our coding agent, write a Pine Script® v6 indicator or strategy from a prompt, or change one in place: the script passed as \`code\`, or one of the member's saved scripts by its \`script_id\` (the result then has a unified diff). Quant works in the background with the Pine Script® reference, checks every attempt with LuxAlgo's linter and fixes what fails, until the script passes or its time runs out. Returns the script, whether it passes the linter and what is still flagged. A script that passes is saved to the member's LuxAlgo account as one of their Quant scripts, where they find it in Vela: a new script, or with \`script_id\` a new version of that script; the result says which, with its script_id. One that does not pass yet is saved nowhere: call again with it as \`code\` (and the same \`script_id\`, if any) and what is left to fix as the prompt.${onChartWords} ${USAGE} To only check a script the member already has, use quant_validate_pine_script, which uses no usage. It writes code; it never runs or backtests it, and it is not trading advice.`,
      inputSchema: z.object({
        prompt: z
          .string()
          .trim()
          .min(1)
          .max(PROMPT_CHARS)
          .describe("What to build or change, in plain words: the logic, inputs, plots and alerts the member wants."),
        code: z
          .string()
          .min(1)
          .max(CODE_CHARS)
          .optional()
          .describe("A Pine Script® to change. Quant edits it in place instead of writing a new one."),
        script_id: z
          .string()
          .trim()
          .min(1)
          .max(128)
          .optional()
          .describe(
            "One of the member's saved scripts to change, by its id from quant_search_user_scripts. Its saved source is what Quant changes unless `code` is passed too, and a result that passes is saved as its new version.",
          ),
        ...(withChart
          ? {
              add_to_chart: z
                .boolean()
                .optional()
                .describe(
                  "Also put the script on the chart the member has open right now in Vela, the one they used last, once it passes and is saved. False by default: set it only when the member asked to see it on their chart.",
                ),
            }
          : {}),
      }),
      // With the option, the call can reach outside: the member's browser.
      annotations: { ...SPENDS, openWorldHint: withChart },
    },
    async (input) => {
      const { prompt, code, script_id } = input;
      const addToChart = withChart && (input as { add_to_chart?: boolean }).add_to_chart === true;
      const startedAt = Date.now();
      try {
        const generation = await generatePineScript({
          prompt,
          ...(code ? { code } : {}),
          ...(script_id ? { scriptId: script_id } : {}),
          timeoutSeconds: timeBudgetSeconds(),
        });
        const saved = generation.savedScript;
        // Only a script that passes and is saved goes on the chart: by its saved id, as the chart tools add one.
        const onChart: OnChart | null = !addToChart
          ? null
          : generation.lint.valid === true && saved && generation.code !== null
            ? await putOnChart(saved.id, startedAt)
            : { status: "not_added", words: "It was not put on the member's Vela chart: only a script that passes and is saved goes there." };
        const structured = {
          id: generation.id,
          status: generation.status,
          stop_reason: generation.stopReason,
          valid: generation.lint.valid,
          code: generation.code,
          diff: generation.diff,
          comment: generation.comment,
          script: generation.script,
          errors: generation.lint.errors,
          warnings: generation.lint.warnings,
          attempts: generation.attempts,
          duration_ms: generation.durationMs,
          saved: saved !== null,
          script_id: saved?.id ?? null,
          ...(saved ? { saved_as: saved.created ? "new_script" : "new_version" } : {}),
          ...(onChart ? { on_chart: onChart.status, ...(onChart.name ? { on_chart_as: onChart.name } : {}) } : {}),
        };
        if (generation.status === "failed" || generation.code === null) {
          const why =
            generation.status === "failed"
              ? "Quant could not be reached, and nothing was used. Try again in a moment."
              : generation.stopReason === "refusal"
                ? `Quant declined this request.${generation.comment ? ` ${generation.comment}` : ""}`
                : generation.stopReason === "insufficient_balance" || generation.stopReason === "spend_limit_reached"
                  ? "The member's Quant usage ran out before a script was written."
                  : "Quant ran out of time before a script was written. Try again with a narrower request.";
          return { ...ok(`No script was written: ${why}`, structured), isError: true };
        }
        const kept = saved
          ? saved.created
            ? `It is saved to the member's LuxAlgo account as one of their Quant scripts (script id ${saved.id}).`
            : `It is saved as the new version of the member's script ${saved.id}.`
          : "It could not be saved to the member's account; the script is below.";
        const verdict =
          generation.lint.valid === true
            ? `It passes LuxAlgo's linter. ${kept}`
            : `It does not pass LuxAlgo's linter yet (${plural(generation.lint.errors.length, "error")}), so it was not saved:\n${diagnosticLines(generation.lint.errors)}\nCall quant_generate_pine_script again with this script as \`code\`${script_id ? " and the same script_id" : ""} to fix them.`;
        const text =
          `${code || script_id ? "Changed" : "Written"} by Quant in ${plural(generation.attempts, "attempt")}. ${verdict}${onChart ? ` ${onChart.words}` : ""}` +
          `${generation.comment ? `\n\n${generation.comment}` : ""}\n\n\`\`\`pine\n${generation.code.replace(/\s+$/, "")}\n\`\`\``;
        return ok(text, structured);
      } catch (error) {
        return failure(error, "No script was written");
      }
    },
  );

  registerProtectedTool(
    server,
    runtime,
    "quant_validate_pine_script",
    {
      title: "Check Pine Script® with LuxAlgo's linter",
      description:
        "Checks a Pine Script® source with LuxAlgo's linter, the one Quant checks its own scripts with: whether it is valid (no errors), every error and warning with its code, message and position (1-based line and column), and what the script declares (indicator, strategy or library, its title, Pine version and overlay). It reads the source only: nothing runs, nothing is saved, and it uses no Quant usage. Use it before telling the member a script works, and after editing one by hand. To have the errors fixed, pass the script to quant_generate_pine_script.",
      inputSchema: z.object({
        code: z.string().min(1).max(CODE_CHARS).describe("The complete Pine Script® source to check."),
      }),
      annotations: READ,
    },
    async ({ code }) => {
      try {
        const lint = await lintPineScript(code);
        const text = lint.valid
          ? `Valid: no errors${lint.warnings.length > 0 ? `, ${plural(lint.warnings.length, "warning")}:\n${diagnosticLines(lint.warnings)}` : " and no warnings."}`
          : `Not valid: ${plural(lint.errors.length, "error")}.\n${diagnosticLines(lint.errors)}`;
        return ok(text, { valid: lint.valid, errors: lint.errors, warnings: lint.warnings, script: lint.script });
      } catch (error) {
        return failure(error, "The script was not checked");
      }
    },
  );

  registerProtectedTool(
    server,
    runtime,
    "quant_search_user_scripts",
    {
      title: "Search my scripts",
      description:
        "Searches the signed-in member's own Pine Script® scripts on LuxAlgo: the ones Quant wrote for them in a chat (`origin: quant`) and the ones they saved from the code editor (`origin: user`). Each result has its id, name, kind (indicator, strategy or library), origin, a one-line description when there is one, and when it was created and last saved; newest first. `query` matches names and descriptions; leave it out for the latest scripts. Results carry no source: fetch one script's code with get_user_script and its id. For LuxAlgo's published indicators use library_search, not this.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(200).optional().describe("Words to look for in script names and descriptions."),
        origin: z.enum(["quant", "user"]).optional().describe("Only scripts Quant wrote, or only the member's own."),
        type: z.enum(["indicator", "strategy", "library"]).optional().describe("Only scripts of this kind."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 20)."),
      }),
      annotations: READ,
    },
    async ({ query, origin, type, limit }) => {
      try {
        const page = await searchUserScripts({ q: query, origin, type, limit: limit ?? 20 });
        const lines = page.scripts.map(
          (script) =>
            `${script.name} (${script.type ?? "script"}, ${script.origin === "quant" ? "written by Quant" : "saved by the member"}, id ${script.id})`,
        );
        const text =
          page.scripts.length === 0
            ? `No script of the member's matches${query ? ` "${query}"` : ""}.`
            : `${page.scripts.length} of ${plural(page.total, "matching script")}: ${lines.join("; ")}. Fetch one's source with get_user_script.`;
        return ok(text, { total: page.total, scripts: page.scripts.map(scriptOut) });
      } catch (error) {
        return failure(error, "The scripts were not searched");
      }
    },
  );

  registerProtectedTool(
    server,
    runtime,
    "get_user_script",
    {
      title: "Get one of my scripts",
      description:
        "The full Pine Script® source of one of the signed-in member's own scripts, by its id from quant_search_user_scripts, with its name, kind and origin. Kept apart from the search because sources are long: call it only when the code itself is needed, for example to change it with quant_generate_pine_script or check it with quant_validate_pine_script. It reads only the member's own scripts; for a LuxAlgo Library indicator's source use library_get_source_code.",
      inputSchema: z.object({
        script_id: z.string().trim().min(1).max(128).describe("The script's id, from quant_search_user_scripts."),
      }),
      annotations: READ,
    },
    async ({ script_id }) => {
      try {
        const script = await getUserScript(script_id);
        const text = `${script.name} (${script.type ?? "script"}, ${script.origin === "quant" ? "written by Quant" : "saved by the member"}):\n\n\`\`\`pine\n${script.code.replace(/\s+$/, "")}\n\`\`\``;
        return ok(text, { ...scriptOut(script), code: script.code });
      } catch (error) {
        return failure(error, "The script was not read");
      }
    },
  );

  registerProtectedTool(
    server,
    runtime,
    "quant_plan_backtest_loop",
    {
      title: "Plan a backtest loop",
      description: `Turns a prompt into the plan of a backtest loop and returns it with a plan_id; it starts nothing. ${LOOP_IS} Quant writes the plan: the markets and timeframes, the tested date range and how much of it is held out, costs, order size, how many strategies to find, a time limit, and the measurable criteria a strategy must meet on every market, with its own estimate of the odds. Say in the prompt what the member said about markets, timeframe, direction, the metrics and thresholds that count as success, the history to test on and the time to spend; ask them first about anything that matters and is open, because the plan cannot ask back. The planning call uses a little of the member's Quant usage. Show the member the plan in plain words and wait for their yes before calling quant_start_backtest_loop with the plan_id. Backtests are history under stated assumptions, never a prediction or trading advice.`,
      inputSchema: z.object({
        prompt: z
          .string()
          .trim()
          .min(1)
          .max(PROMPT_CHARS)
          .describe(
            'What to search for, in the member\'s terms, e.g. "a long-only trend strategy on BTCUSDT 1 hour bars over the last 2 years, profit factor at least 1.5, max drawdown under 15%, at least 60 trades, 30 minutes".',
          ),
      }),
      annotations: SPENDS,
    },
    async ({ prompt }) => {
      try {
        const proposed = await planBacktestLoop({ prompt, timeoutSeconds: timeBudgetSeconds() });
        const access =
          proposed.access === "run"
            ? "It has not started. Show the member this plan and, on their yes, call quant_start_backtest_loop with the plan_id."
            : proposed.access === "upgrade"
              ? "It has not started, and the member's plan cannot start it: backtest loops run on the Ultimate and Ultra plans (https://app.luxalgo.com/account/plan)."
              : "It has not started, and it cannot until the member's paused plan resumes (https://app.luxalgo.com/account/plan).";
        const text = `Planned, not started: ${planWords(proposed.plan)} Quant's estimate that it finds one: ${num(proposed.assessment.chancePct, 0)}% (${proposed.assessment.rationale}) ${access}`;
        return ok(text, {
          plan_id: proposed.planId,
          access: proposed.access,
          can_start: proposed.access === "run",
          plan: proposed.plan,
          assessment: { chance_pct: proposed.assessment.chancePct, rationale: proposed.assessment.rationale },
        });
      } catch (error) {
        return failure(error, "Nothing was planned");
      }
    },
  );

  registerProtectedTool(
    server,
    runtime,
    "quant_start_backtest_loop",
    {
      title: "Start a backtest loop",
      description: `Starts the backtest loop of a plan the member approved, by the plan_id quant_plan_backtest_loop returned, and returns its loop id. ${LOOP_IS} Call it only after you showed the member that plan and they said yes in their own words; never start one on their behalf. Once started it runs on LuxAlgo's servers, for up to the plan's time limit, whether or not this chat stays open, and every attempt it makes uses the member's Quant usage until it ends or quant_stop_backtest_loop stops it. A plan starts at most one loop: starting it again returns the loop it already started. It returns the loop id, not strategies: follow it with quant_get_backtest_loop_info. ${READ_RESULTS} Backtest loops run on the Ultimate and Ultra plans; the LuxAlgo app decides.`,
      inputSchema: z.object({
        plan_id: z.string().trim().min(1).max(128).describe("The plan_id quant_plan_backtest_loop returned."),
      }),
      annotations: START,
    },
    async ({ plan_id }) => {
      try {
        const started = await startBacktestLoop(plan_id);
        // A plan starts at most one loop: when that loop has already ended, nothing new was started.
        const text = isGoing(started.status)
          ? `Started: the backtest loop is ${statusWords(started.status)} on LuxAlgo's servers (loop id ${started.loopId}). It uses the member's Quant usage until it ends; quant_stop_backtest_loop stops it, and quant_get_backtest_loop_info says where it stands and what it has found so far. Its Loop Report in Vela: ${started.reportUrl}`
          : `Nothing new was started: this plan already started loop ${started.loopId}, which already ended (${statusWords(started.status)}). A plan starts at most one loop; to run another, plan again with quant_plan_backtest_loop.`;
        return ok(text, {
          loop_id: started.loopId,
          status: started.status,
          running: isGoing(started.status),
          report_url: started.reportUrl,
        });
      } catch (error) {
        return failure(error, "Nothing was started");
      }
    },
  );

  registerProtectedTool(
    server,
    runtime,
    "quant_stop_backtest_loop",
    {
      title: "Stop a backtest loop",
      description:
        "Stops one of the member's backtest loops by its id: it finishes the attempt it is on, stops spending Quant usage, and keeps every strategy it found and tested. A stopped loop is not lost: the member can resume it from its Loop Report in Vela, where it picks up after its last attempt. A loop that already ended is left as it is, and the result says so. It never deletes a loop or its strategies.",
      inputSchema: z.object({ loop_id: loopIdInput }),
      annotations: STOP,
    },
    async ({ loop_id }) => {
      try {
        const result = await stopBacktestLoop(loop_id);
        const text = result.stopped
          ? "Stopped: the loop ends after the attempt it is on and keeps what it found. The member can resume it from its Loop Report in Vela."
          : `Nothing to stop: the loop already ended (${statusWords(result.status)}).`;
        return ok(text, { loop_id, stopped: result.stopped, status: result.status });
      } catch (error) {
        return failure(error, "The loop was not stopped");
      }
    },
  );

  registerProtectedTool(
    server,
    runtime,
    "quant_list_backtest_loops",
    {
      title: "List my backtest loops",
      description: `The signed-in member's backtest loops, newest first: each one's id, status, whether it is active (\`active\` is true while it is running or waiting for more Quant usage), its markets, how many strategies it found against how many the plan asked for, its attempts, the time it has used against its limit, when it started and ended, and its report_url. \`active: true\` lists only the ones still going; \`active: false\` only the ones that ended. The first one listed is the member's most recent loop. ${READ_RESULTS}`,
      inputSchema: z.object({
        active: z.boolean().optional().describe("true: only loops still going; false: only loops that ended. Default: both."),
        limit: z.number().int().min(1).max(20).optional().describe("Max loops (default 20, the most one call returns)."),
      }),
      annotations: READ,
    },
    async ({ active, limit }) => {
      try {
        const { loops } = await listBacktestLoops({ active, limit: limit ?? 20 });
        const going = loops.filter((loop) => loop.active).length;
        const text =
          loops.length === 0
            ? `The member has no ${active === true ? "active " : active === false ? "finished " : ""}backtest loops.`
            : `${plural(loops.length, "backtest loop")}, ${going} active. ${loops.map((loop) => `${loopWords(loop)} (id ${loop.id})`).join("; ")}.`;
        return ok(text, { loops: loops.map(loopOut) });
      } catch (error) {
        return failure(error, "The loops were not listed");
      }
    },
  );

  registerProtectedTool(
    server,
    runtime,
    "quant_get_backtest_loop_info",
    {
      title: "Get a backtest loop's status and strategies",
      description: `Where one of the member's backtest loops stands, by its id: its status and whether it is still active, why it stopped when it did, Quant's closing summary once it ended, its markets, how many strategies it found against how many the plan asked for, its attempts and the time it has used against its limit, its report_url, and what it found so far: \`strategies\`, its best ones (10 at most) with each one's id, attempt number, whether it meets every criterion, its in-sample score (0 to 100) and a line on what it does, and \`best_strategy_id\`, the first of them. Best means the ones that meet every criterion on every market, held-out data included, then the highest score; while nothing passes, it is the closest attempt, so say so. Read one with quant_get_backtest_loop_strategy. ${CHART_IN_VELA} While a loop is running, ask again no more than about once a minute.`,
      inputSchema: z.object({ loop_id: loopIdInput }),
      annotations: READ,
    },
    async ({ loop_id }) => {
      try {
        const loop = await getBacktestLoop(loop_id);
        const text =
          `${loopWords(loop)}.` +
          // The closing summary of a loop that ended badly repeats why: say it once.
          `${loop.statusReason && !loop.summary?.includes(loop.statusReason) ? ` ${loop.statusReason}` : ""}` +
          `${foundWords(loop)} Its Loop Report in Vela: ${loop.reportUrl}` +
          `${loop.summary ? `\n\n${loop.summary}` : ""}`;
        return ok(text, { loop: loopInfoOut(loop) });
      } catch (error) {
        return failure(error, "The loop was not read");
      }
    },
  );

  registerProtectedTool(
    server,
    runtime,
    "quant_get_backtest_loop_strategy",
    {
      title: "Get a strategy a backtest loop found",
      description: `One strategy of one of the member's backtest loops, by its id from quant_get_backtest_loop_info (\`best_strategy_id\`, or an id in \`strategies\`): whether it meets every criterion, what it does and how it trades in Quant's words, its Pine Script® source as it goes on a chart, and each market's backtest on the data it was developed on (\`in_sample\`) and on the data held out from it (\`out_of_sample\`): the verdict, every criterion against its threshold, the metrics (net profit, profit factor, trades, win rate, drawdown and the rest, by their plan names) and the run's statistics (dates, bars, Sharpe, Sortino, CAGR, run-up, buy and hold). For "what was the best strategy of my latest loop?", call quant_list_backtest_loops (newest first), then quant_get_backtest_loop_info, then this with its best_strategy_id. Quote the numbers as returned, name whether each is in sample or held out, and never round a failing strategy up to a passing one. It returns no trade list and no equity curve. ${CHART_IN_VELA} It reads only; it uses no Quant usage. ${HISTORY_ONLY}`,
      inputSchema: z.object({
        strategy_id: z
          .string()
          .trim()
          .min(3)
          .max(160)
          .describe("The strategy's id, from quant_get_backtest_loop_info: best_strategy_id, or an id in strategies."),
      }),
      annotations: READ,
    },
    async ({ strategy_id }) => {
      try {
        const strategy = await getBacktestLoopStrategy(strategy_id);
        const text =
          `${strategyWords(strategy)}\n${HISTORY_ONLY} Its Loop Report in Vela: ${strategy.reportUrl}` +
          `\n\n\`\`\`pine\n${strategy.code.replace(/\s+$/, "")}\n\`\`\``;
        return ok(text, { strategy: strategyOut(strategy) });
      } catch (error) {
        return failure(error, "The strategy was not read");
      }
    },
  );
}

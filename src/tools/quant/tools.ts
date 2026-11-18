/*
  Quant, our coding agent, for the signed-in member's AI assistant: write and
  check Pine Script®, find the member's saved scripts, and plan, start, stop
  and follow backtest loops (Quant writing and backtesting strategy versions
  until enough of them meet the plan's criteria).

  A script Quant writes here is kept in the member's LuxAlgo account as one of
  their Quant scripts. The loop tools only set a loop going and say where it
  stands: what a loop finds is the member's to read in Vela, in its Loop
  Report, and no tool here returns a strategy.

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
*/
import { z } from "zod";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { registerProtectedTool } from "../../auth/protected-tool.js";
import type { AuthRuntime } from "../../auth/runtime.js";
import { AppApiError, AppAuthError, AppPermissionError } from "../../platform/app-client.js";
import { errorMessage, ok, textError } from "../_shared/result.js";
import {
  generatePineScript,
  getBacktestLoop,
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
const RESULTS_IN_VELA =
  "These tools set a loop going and say where it stands; they do not return the strategies it finds. The member reads those in Vela, in the loop's Loop Report (report_url), where they can put them on a chart.";

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

const loopInfoOut = (loop: LoopInfo) => ({
  ...loopOut(loop),
  ...(loop.statusReason ? { status_reason: loop.statusReason } : {}),
  ...(loop.summary ? { summary: loop.summary } : {}),
});

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
  registerProtectedTool(
    server,
    runtime,
    "quant_generate_pine_script",
    {
      title: "Write Pine Script® with Quant",
      description: `Has Quant, our coding agent, write a Pine Script® v6 indicator or strategy from a prompt, or change one in place: the script passed as \`code\`, or one of the member's saved scripts by its \`script_id\` (the result then has a unified diff). Quant works in the background with the Pine Script® reference, checks every attempt with LuxAlgo's linter and fixes what fails, until the script passes or its time runs out. Returns the script, whether it passes the linter and what is still flagged. A script that passes is saved to the member's LuxAlgo account as one of their Quant scripts, where they find it in Vela: a new script, or with \`script_id\` a new version of that script; the result says which, with its script_id. One that does not pass yet is saved nowhere: call again with it as \`code\` (and the same \`script_id\`, if any) and what is left to fix as the prompt. ${USAGE} To only check a script the member already has, use quant_validate_pine_script, which uses no usage. It writes code; it never runs or backtests it, and it is not trading advice.`,
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
      }),
      annotations: SPENDS,
    },
    async ({ prompt, code, script_id }) => {
      try {
        const generation = await generatePineScript({
          prompt,
          ...(code ? { code } : {}),
          ...(script_id ? { scriptId: script_id } : {}),
          timeoutSeconds: timeBudgetSeconds(),
        });
        const saved = generation.savedScript;
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
          `${code || script_id ? "Changed" : "Written"} by Quant in ${plural(generation.attempts, "attempt")}. ${verdict}` +
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
      description: `Starts the backtest loop of a plan the member approved, by the plan_id quant_plan_backtest_loop returned, and returns its loop id. ${LOOP_IS} Call it only after you showed the member that plan and they said yes in their own words; never start one on their behalf. Once started it runs on LuxAlgo's servers, for up to the plan's time limit, whether or not this chat stays open, and every attempt it makes uses the member's Quant usage until it ends or quant_stop_backtest_loop stops it. A plan starts at most one loop: starting it again returns the loop it already started. Follow it with quant_get_backtest_loop_info. ${RESULTS_IN_VELA} Backtest loops run on the Ultimate and Ultra plans; the LuxAlgo app decides.`,
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
          ? `Started: the backtest loop is ${statusWords(started.status)} on LuxAlgo's servers (loop id ${started.loopId}). It uses the member's Quant usage until it ends; quant_stop_backtest_loop stops it, and quant_get_backtest_loop_info says where it stands. The member reads what it finds in Vela: ${started.reportUrl}`
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
      description: `The signed-in member's backtest loops, newest first: each one's id, status, whether it is active (\`active\` is true while it is running or waiting for more Quant usage), its markets, how many strategies it found against how many the plan asked for, its attempts, the time it has used against its limit, when it started and ended, and its report_url. \`active: true\` lists only the ones still going; \`active: false\` only the ones that ended. ${RESULTS_IN_VELA}`,
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
      title: "Get a backtest loop's status",
      description: `Where one of the member's backtest loops stands, by its id: its status and whether it is still active, why it stopped when it did, Quant's closing summary once it ended, its markets, how many strategies it found against how many the plan asked for, its attempts and the time it has used against its limit, and its report_url. ${RESULTS_IN_VELA} While a loop is running, ask again no more than about once a minute.`,
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
          ` The member reads its strategies in Vela, in its Loop Report: ${loop.reportUrl}` +
          `${loop.summary ? `\n\n${loop.summary}` : ""}`;
        return ok(text, { loop: loopInfoOut(loop) });
      } catch (error) {
        return failure(error, "The loop was not read");
      }
    },
  );
}

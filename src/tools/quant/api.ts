/*
  Typed wrappers over the LuxAlgo app's Quant routes for AI assistants
  (`/api/agents/quant/*`). Every route needs a signed-in member and reaches
  only their own scripts, plans and backtest loops; the app checks that, the
  member's plan and their Quant usage, not this server. The routes answer 404
  while the app has them switched off.

  A script Quant writes here is kept in the member's LuxAlgo account as one of
  their Quant scripts. A backtest loop is planned, started, stopped and
  followed here (where it stands), and what it found is read here too: a
  loop's info lists its strategies by id, best first, and a strategy's id
  reads its code and each market's backtest. Charting and comparing them is
  in Vela, in the loop's Loop Report.

  Three of them spend the member's Quant usage, and the app meters it: a
  generation (each attempt), a backtest loop plan (the planning call) and a
  running backtest loop (every attempt it makes, until it ends or is stopped).

  Shapes mirror the app's wire contracts (app: src/app/api/agents/quant).
*/
import { appGet, appSend } from "../../platform/app-client.js";

// ── Pine Script® ────────────────────────────────────────────────────────────

/** One finding of LuxAlgo's Pine Script® linter. Positions are 1-based; the end is exclusive. */
export type PineDiagnostic = {
  code: string;
  message: string;
  line?: number;
  column?: number;
  end_line?: number;
  end_column?: number;
};

/** What a script declares about itself; null when it has no declaration statement. */
export type PineScriptInfo = {
  type: "indicator" | "strategy" | "library";
  title: string | null;
  short_title: string | null;
  pine_version: number | null;
  overlay: boolean | null;
} | null;

export type PineLint = {
  valid: boolean;
  errors: PineDiagnostic[];
  warnings: PineDiagnostic[];
  script: PineScriptInfo;
};

export type PineGeneration = {
  id: string;
  /** completed: Quant finished; incomplete: a limit cut it short (see stopReason); failed: no model could be reached, nothing was used. */
  status: "completed" | "incomplete" | "failed";
  stopReason:
    | "passed"
    | "max_attempts"
    | "max_output_tokens"
    | "timeout"
    | "refusal"
    | "edit_failed"
    | "insufficient_balance"
    | "spend_limit_reached"
    | null;
  /** The script as it stands; null when no attempt produced one. */
  code: string | null;
  /** A unified diff against the script that was passed in; null for a new script. */
  diff: string | null;
  comment: string | null;
  script: PineScriptInfo;
  /** `valid` is null when there is no script to check. */
  lint: { valid: boolean | null; errors: PineDiagnostic[]; warnings: PineDiagnostic[] };
  /** Write, lint and fix rounds that ran. */
  attempts: number;
  durationMs: number;
  /** The member's script it was kept as, and whether that script is new; null when nothing was saved (no script, or one that does not pass yet). */
  savedScript: { id: string; created: boolean } | null;
};

export const generatePineScript = (body: { prompt: string; code?: string; scriptId?: string; timeoutSeconds: number }) =>
  appSend<PineGeneration>("POST", "/api/agents/quant/generations", { body });

export const lintPineScript = (code: string) =>
  appSend<PineLint>("POST", "/api/agents/quant/pine/lint", { body: { code } });

// ── the member's scripts ────────────────────────────────────────────────────

export type UserScriptSummary = {
  id: string;
  name: string;
  /** null for a script saved before its kind was recorded. */
  type: "indicator" | "strategy" | "library" | null;
  /** quant: written by Quant in a chat; user: saved by the member from the code editor. */
  origin: "quant" | "user";
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UserScriptsPage = { scripts: UserScriptSummary[]; total: number };

export type UserScript = UserScriptSummary & { code: string };

export const searchUserScripts = (query: {
  q?: string;
  origin?: "quant" | "user";
  type?: "indicator" | "strategy" | "library";
  limit?: number;
}) =>
  appGet<UserScriptsPage>("/api/agents/quant/scripts", {
    q: query.q,
    origin: query.origin,
    type: query.type,
    limit: query.limit === undefined ? undefined : String(query.limit),
  });

export const getUserScript = async (scriptId: string) =>
  (await appGet<{ script: UserScript }>(`/api/agents/quant/scripts/${encodeURIComponent(scriptId)}`)).script;

// ── backtest loops ──────────────────────────────────────────────────────────

/** One acceptance criterion of a market: a metric with a minimum, a maximum or both. */
export type LoopCriterion = { metric: string; min: number | null; max: number | null };

/** One market a loop tests. `from` / `to` are Unix milliseconds (UTC). */
export type LoopPlanMarket = {
  ticker: string;
  /** Bar size in minutes. */
  timeframe: number;
  session?: "regular" | "extended";
  window: { from: number; to: number; out_of_sample_pct: number; out_of_sample_at: "start" | "end" };
  costs: { commission: { value: number; method: string }; slippage_ticks: number };
  side: "all" | "long" | "short";
  criteria: LoopCriterion[];
};

/** A backtest loop's plan as the app stores it (the fields these tools read). */
export type LoopPlan = {
  strategies_required: number;
  legs: LoopPlanMarket[];
  capital: {
    initial_capital: number;
    order_size: { method: string; value: number };
    pyramiding: number;
  };
  instructions: string | null;
  time_limit_minutes: number;
};

export type LoopPlanProposal = {
  /** What quant_start_backtest_loop takes. */
  planId: string;
  plan: LoopPlan;
  /** Quant's own estimate of the odds that the loop finds a strategy, with why. */
  assessment: { chancePct: number; rationale: string };
  /** run: the member's plan can start it; upgrade: it needs Ultimate or Ultra; resume: their plan is paused. */
  access: "run" | "upgrade" | "resume";
};

export type LoopStatus = "running" | "paused_budget" | "succeeded" | "timed_out" | "stuck" | "cancelled" | "failed";

export type LoopSummary = {
  id: string;
  status: LoopStatus;
  /** True while the loop is running, or waiting for more Quant usage to carry on. */
  active: boolean;
  markets: Array<{ ticker: string; timeframe: number }>;
  strategiesFound: number;
  strategiesRequired: number;
  attempts: number;
  activeSeconds: number;
  timeLimitSeconds: number;
  createdAt: string;
  finishedAt: string | null;
  /** The loop's Loop Report in Vela: where the member charts and compares what it found. */
  reportUrl: string;
};

/** One of a loop's strategies, as its info lists it. */
export type LoopStrategyRef = {
  /** What quant_get_backtest_loop_strategy takes. */
  id: string;
  /** Its attempt number in the loop, as the Loop Report shows it. */
  attempt: number;
  /** Meets every criterion on every market, held-out data included. */
  passed: boolean;
  /** 0 to 100, in sample: 100 meets every criterion there. */
  score: number;
  /** One of the strategies the loop handed back when it ended. */
  handedBack: boolean;
  /** The member's script it was saved as, when it was. */
  scriptId: string | null;
  description: string | null;
};

export type LoopInfo = LoopSummary & {
  statusReason: string | null;
  /** Quant's closing write-up, once the loop has ended. */
  summary: string | null;
  /** The first of `strategies`; null while no attempt has reached a backtest. */
  bestStrategyId: string | null;
  /** The loop's strategies so far, best first, 10 at most. */
  strategies: LoopStrategyRef[];
};

/** The statistics of one backtest run. Amounts are in the account currency; `from` / `to` are ISO times of its first and last bars. */
export type LoopBacktestStats = {
  from: string;
  to: string;
  bars: number;
  initialCapital: number;
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  openProfit: number;
  cagrPct: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  maxRunup: number;
  maxRunupPct: number;
  sharpeRatio: number;
  sortinoRatio: number;
  buyAndHoldPnl: number;
  buyAndHoldPct: number;
  strategyOutperformance: number;
};

/** One market of a strategy on one dataset: developed on (in sample) or held out from it (out of sample). */
export type LoopStrategyWindow = {
  passed: boolean;
  /** Each criterion with the threshold applied to this window and the value the backtest gave. */
  criteria: Array<{
    metric: string;
    min: number | null;
    max: number | null;
    value: number | null;
    passed: boolean;
    detail: string | null;
  }>;
  /** Integrity checks the window failed (lookahead, repainting). */
  problems: string[];
  /** Every metric the loop computed for the window, by its plan name (`profit_factor`, `max_drawdown_pct`, …). */
  metrics: Record<string, number | null> | null;
  /** Null for an attempt from before runs were kept. */
  backtest: LoopBacktestStats | null;
};

export type LoopStrategy = {
  id: string;
  loopId: string;
  attempt: number;
  passed: boolean;
  outcome: string;
  score: number | null;
  family: string | null;
  description: string | null;
  notes: string | null;
  /** How it trades, in words. */
  behavior: string | null;
  handedBack: boolean;
  scriptId: string | null;
  /** Its Pine Script® as it goes on a chart, the plan's settings written in. */
  code: string;
  markets: Array<{
    ticker: string;
    timeframe: number | null;
    inSample: LoopStrategyWindow;
    outOfSample: LoopStrategyWindow | null;
  }>;
  reportUrl: string;
};

export const planBacktestLoop = (body: { prompt: string; timeoutSeconds: number }) =>
  appSend<LoopPlanProposal>("POST", "/api/agents/quant/backtest-loops/plans", { body });

export const startBacktestLoop = (planId: string) =>
  appSend<{ loopId: string; status: LoopStatus; reportUrl: string }>("POST", "/api/agents/quant/backtest-loops", {
    body: { planId },
  });

export const stopBacktestLoop = (loopId: string) =>
  appSend<{ stopped: boolean; status: LoopStatus }>(
    "POST",
    `/api/agents/quant/backtest-loops/${encodeURIComponent(loopId)}/stop`,
  );

export const listBacktestLoops = (query: { active?: boolean; limit?: number }) =>
  appGet<{ loops: LoopSummary[] }>("/api/agents/quant/backtest-loops", {
    active: query.active === undefined ? undefined : String(query.active),
    limit: query.limit === undefined ? undefined : String(query.limit),
  });

export const getBacktestLoop = async (loopId: string) =>
  (await appGet<{ loop: LoopInfo }>(`/api/agents/quant/backtest-loops/${encodeURIComponent(loopId)}`)).loop;

export const getBacktestLoopStrategy = async (strategyId: string) =>
  (
    await appGet<{ strategy: LoopStrategy }>(
      `/api/agents/quant/backtest-loops/strategies/${encodeURIComponent(strategyId)}`,
    )
  ).strategy;

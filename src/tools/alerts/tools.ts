/*
  LuxAlgo Alerts for the signed-in member: Price Alerts (price crosses a
  level) and Custom Alerts (an indicator's condition), the same alerts Vela
  shows on the web and in the Vela apps.

  Nothing about plans is decided here: how many alerts the member may have
  on is the app's answer (a 403 the auth wrapper turns into the plan
  message). Alerts made here notify the member's in-app channel (their
  phones and the web) when they have one; the app reaches this server only
  that channel's id and status, never the rest of their destinations. With
  none, the alert is created without a channel and the result says so.

  Custom Alerts go through the app's preview first: it resolves the
  indicator, validates the rule and replays it over recent history ("would
  have fired 12 times, about 0.4 per day"), and its answer is the rule the
  create takes. Previews are limited per member (about 10 a minute).

  No edit and no delete: the app's MCP allowlist has neither.
*/
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerProtectedTool } from "../../auth/protected-tool.js";
import type { AuthRuntime } from "../../auth/runtime.js";
import { AppApiError, AppAuthError, AppPermissionError, isNotFound } from "../../platform/app-client.js";
import { TIMEFRAME_KEYS, type Timeframe } from "../chart/market.js";
import { storeFor } from "../chart/backend.js";
import { errorMessage, ok, textError } from "../_shared/result.js";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { MARKET_INPUT_HELP, marketChartUrl, marketId, marketWords, parseMarketInput, type MemberMarket } from "../_shared/markets.js";
import {
  createAlert,
  inAppDestinations,
  listAlertEvents,
  listAlerts,
  pauseAlert,
  previewAlert,
  resumeAlert,
  type AlertFrequency,
  type AlertView,
} from "./api.js";
import {
  TF_MINUTES,
  canonicalLevel,
  chartTimeframe,
  conditionWords,
  eventPrice,
  frequencyWords,
  previewWords,
  scopeMarket,
  scopeWords,
  stateWords,
  typeWords,
  usageWords,
} from "./words.js";

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

const PLAN_NOTE =
  "How many alerts the member may have on comes from their LuxAlgo plan: at a limit the call answers with the limit and where to upgrade, and nothing is created.";
const CONFIRM_NOTE = "It changes the member's account, so the chat app may ask the user to confirm first.";
const NOT_OPEN = "LuxAlgo Alerts are not open on this account yet (the LuxAlgo app answered 404).";

// ── shared pieces ────────────────────────────────────────────────────────────

const alertIdInput = z.string().min(1).max(128).describe("The alert's id, from alerts_list or the result that created it.");

const frequencyInput = z
  .enum(["once", "once_per_bar", "once_per_bar_close", "every_time"])
  .describe(
    "How often it fires: once (then it stops), once_per_bar (at most once per bar of `timeframe`), once_per_bar_close (when a bar of `timeframe` closes with the condition met), every_time (each time, spaced by min_interval_seconds).",
  );
const timeframeInput = z.enum(TIMEFRAME_KEYS);
const minIntervalInput = z
  .number()
  .int()
  .min(1)
  .max(604_800)
  .optional()
  .describe("every_time only: the least time between two fires, in seconds (default 60).");

function frequencyOf(kind: z.infer<typeof frequencyInput>, tf: Timeframe, minIntervalSeconds?: number): AlertFrequency {
  switch (kind) {
    case "once":
      return { kind: "once" };
    case "once_per_bar":
      return { kind: "once_per_bar", tf: TF_MINUTES[tf] };
    case "once_per_bar_close":
      return { kind: "once_per_bar_close", tf: TF_MINUTES[tf] };
    case "every_time":
      return { kind: "every_time", minIntervalMs: (minIntervalSeconds ?? 60) * 1000 };
  }
}

/** One alert for a result: words, ids, its market's chart link. */
function alertView(view: AlertView) {
  const { rule } = view;
  const market = scopeMarket(rule.scope);
  const tf = "tf" in rule.frequency ? rule.frequency.tf : undefined;
  return {
    id: rule.id,
    kind: typeWords(rule.type),
    name: rule.name,
    market: market ? marketId(market) : scopeWords(rule.scope),
    condition: conditionWords(view),
    frequency: frequencyWords(rule.frequency),
    state: stateWords(view),
    notifies: rule.actions.length > 0 ? "a notification channel" : "no one",
    created_at: view.createdAt,
    ...(market ? { chart_url: marketChartUrl(market, chartTimeframe(tf)) } : {}),
  };
}

function alertSentence(view: AlertView): string {
  const v = alertView(view);
  return `${v.kind} "${v.name}" (id ${v.id}): ${scopeWords(view.rule.scope)} ${v.condition}; ${v.frequency}; ${v.state}.`;
}

/** The member's in-app channel to notify, and the sentence that says where the alert goes. */
async function notifyChannel(): Promise<{ actions: Array<{ destinationId: string }>; words: string; channel: string }> {
  const destinations = await inAppDestinations();
  const active = destinations.find((d) => d.status === "active");
  if (active) {
    return {
      actions: [{ destinationId: active.id }],
      words: "It notifies the member in-app: in Vela on the web and on their phone with the Vela app.",
      channel: "in-app",
    };
  }
  return {
    actions: [],
    words:
      "It notifies no one yet: this account has no in-app alert channel. Saving any alert once in Vela, on the web or in the Vela app on a phone, sets one up; this alert then needs a channel added in Vela.",
    channel: "none",
  };
}

/** Errors a write turns into words; sign-in and plan answers always go up to the auth wrapper. */
function writeFailure(error: unknown, what: string): CallToolResult {
  if (error instanceof AppAuthError || error instanceof AppPermissionError) throw error;
  if (error instanceof AppApiError && error.status === 404) return textError(`${what}: ${NOT_OPEN}`);
  if (error instanceof AppApiError && error.status === 429)
    return textError(`${what}: too many requests for this account right now (${error.message}). Wait a minute and try again.`);
  return textError(`${what}: ${errorMessage(error)}.`);
}

/** Draws a Price Alert's level on a chart open in the chat (chart_open); the words say what happened. */
async function drawLevel(chartId: string, level: string, label: string): Promise<string> {
  try {
    const store = storeFor(chartId);
    if (!store) return ` The chart "${chartId}" is not open any more, so the level was not drawn.`;
    const pushed = await store.push([{ op: "add_level", price: Number(level), label }]);
    if ("gone" in pushed) return ` The chart "${chartId}" is not open any more, so the level was not drawn.`;
    if ("refused" in pushed) return ` The level was not drawn on the chart: ${pushed.refused}.`;
    return " Its level is drawn on the open chart.";
  } catch (error) {
    if (error instanceof AppAuthError || error instanceof AppPermissionError) throw error;
    return ` The level was not drawn on the chart (${errorMessage(error)}).`;
  }
}

const parsedMarket = (input: string): MemberMarket | CallToolResult => {
  const parsed = parseMarketInput(input);
  return "error" in parsed ? textError(`Nothing was created: ${parsed.error}.`) : parsed;
};
const isResult = (value: unknown): value is CallToolResult => typeof value === "object" && value !== null && "content" in value;

// ── Custom Alert conditions ──────────────────────────────────────────────────

const NATIVE_TYPES = ["moving-average", "rsi", "macd", "bollinger-bands", "average-true-range", "stochastic", "supertrend"] as const;
const COMPARISONS = { crosses_above: "crossover", crosses_below: "crossunder", crosses: "cross", above: ">", below: "<" } as const;
const COMPARISON_WORDS = { crosses_above: "crosses above", crosses_below: "crosses below", crosses: "crosses", above: "is above", below: "is below" } as const;

const settingsInput = z
  .record(z.string().max(60), z.union([z.number(), z.string().max(100), z.boolean()]))
  .optional();

// ── registration ─────────────────────────────────────────────────────────────

export function registerAlertTools(server: McpServer, runtime: AuthRuntime) {
  registerProtectedTool(
    server,
    runtime,
    "alerts_list",
    {
      title: "My alerts",
      description:
        "The signed-in member's LuxAlgo Alerts, Price Alerts and Custom Alerts, as Vela shows them: each alert's id, name, market, what it waits for (a Price Alert's level is the member's own), how often it fires, whether it is on, paused, fired or held back, whether it notifies anyone, and a Vela chart link for its market; plus how many of each kind are on against what the member's plan allows. Use it to answer what alerts the member has and to get an id for alerts_pause, alerts_resume or alerts_history.",
      inputSchema: z.object({
        type: z.enum(["price", "custom"]).optional().describe("Only Price Alerts or only Custom Alerts."),
        status: z.enum(["active", "paused", "triggered", "expired", "suspended_plan", "error"]).optional().describe("Only alerts in this state."),
      }),
      annotations: READ,
    },
    async ({ type, status }) => {
      try {
        const { rules, usage } = await listAlerts({ type: type === "custom" ? "agent" : type, status });
        const usageText = `Plan usage: ${usageWords(usage)}`;
        if (rules.length === 0) return ok(`No alerts${type || status ? " match" : " yet"}. ${usageText}`, { alerts: [], usage });
        return ok(`${rules.length} alert${rules.length === 1 ? "" : "s"}:\n${rules.map((v) => `- ${alertSentence(v)}`).join("\n")}\n${usageText}`, {
          alerts: rules.map(alertView),
          usage,
        });
      } catch (error) {
        return writeFailure(error, "Could not read the alerts");
      }
    },
  );

  registerProtectedTool(
    server,
    runtime,
    "alerts_create_price",
    {
      title: "Create a Price Alert",
      description: `Creates a Price Alert in the signed-in member's account: it fires when a market's price crosses, crosses above, crosses below, is above or is below a level the member chose, as often as \`frequency\` says. It notifies the member in-app (Vela on the web and on their phone) when the account has that channel; the result says plainly which channel it notifies, or that it notifies no one. With \`chart_id\` from chart_open it also draws the level on that chart. Use alerts_create_custom for an indicator's condition instead. ${PLAN_NOTE} ${CONFIRM_NOTE}`,
      inputSchema: z.object({
        symbol: z.string().min(1).max(60).describe(`The market, ${MARKET_INPUT_HELP}`),
        condition: z
          .enum(["cross", "cross_up", "cross_down", "above", "below"])
          .describe("cross: price crosses the level either way; cross_up: crosses above it; cross_down: crosses below it; above / below: price is above / below it."),
        level: z.union([z.number().positive(), z.string().min(1).max(64)]).describe('The price level, e.g. 100000 or "0.00012345".'),
        frequency: frequencyInput.default("once"),
        timeframe: timeframeInput.default("1h").describe("The bar for once_per_bar and once_per_bar_close."),
        min_interval_seconds: minIntervalInput,
        name: z.string().trim().min(1).max(120).optional().describe("The alert's name; default says the market and the level."),
        chart_id: z.string().max(200).optional().describe("A chart_id from chart_open: the level is also drawn on that chart."),
      }),
      annotations: WRITE,
    },
    async ({ symbol, condition, level, frequency, timeframe, min_interval_seconds, name, chart_id }) => {
      const market = parsedMarket(symbol);
      if (isResult(market)) return market;
      const canonical = canonicalLevel(level);
      if (!canonical) return textError(`Nothing was created: "${level}" is not a positive price.`);
      const words = { cross: "crosses", cross_up: "crosses above", cross_down: "crosses below", above: "is above", below: "is below" }[condition];
      const alertName = name ?? `${market.symbol} ${words} ${canonical}`.slice(0, 120);
      try {
        const channel = await notifyChannel();
        const view = await createAlert({
          type: "price",
          name: alertName,
          scope: { kind: "market", market: { source: market.source, symbol: market.symbol } },
          condition: { kind: condition, level: canonical },
          frequency: frequencyOf(frequency, timeframe, min_interval_seconds),
          actions: channel.actions,
        });
        const drawn = chart_id ? await drawLevel(chart_id, canonical, alertName.slice(0, 40)) : "";
        const v = alertView(view);
        const text =
          `Created the Price Alert "${view.rule.name}" (id ${view.rule.id}): ${marketWords(market)} ${words} ${canonical}; ${v.frequency}. It is ${v.state}. ${channel.words}${drawn}` +
          (v.chart_url ? ` The market on Vela: ${v.chart_url}` : "");
        return ok(text, { alert: v, notifies: channel.channel });
      } catch (error) {
        return writeFailure(error, "The Price Alert was not created");
      }
    },
  );

  registerProtectedTool(
    server,
    runtime,
    "alerts_create_custom",
    {
      title: "Create a Custom Alert",
      description: `Creates a Custom Alert in the signed-in member's account from an indicator's condition on one market and timeframe: either a Vela built-in indicator (\`indicator\`: RSI crosses above 70, MACD crosses above its signal line, price crosses below the lower Bollinger Band…) or an open-source LuxAlgo Library indicator (\`library\`: its slug, from library_search, firing on one of its alert conditions or on its alerts). It first replays the alert over recent history and says how often it would have fired ("12 times, about 0.4 per day"); with \`preview_only\` it stops there and creates nothing, which is the way to try a condition before the member decides. Paid Library indicators cannot run as alerts. It notifies the member in-app when the account has that channel; the result says plainly which channel it notifies, or that it notifies no one. Previews are limited to about 10 a minute. Use alerts_create_price for a plain price level. ${PLAN_NOTE} ${CONFIRM_NOTE}`,
      inputSchema: z.object({
        symbol: z.string().min(1).max(60).describe(`The market, ${MARKET_INPUT_HELP}`),
        timeframe: timeframeInput.default("1h").describe("The bars the indicator runs on."),
        indicator: z
          .object({
            type: z.enum(NATIVE_TYPES).describe("The Vela built-in indicator."),
            settings: settingsInput.describe(
              'Its settings, Vela\'s names, e.g. {"length": 14} for RSI, {"fastLength": 12, "slowLength": 26, "signalLength": 9} for MACD, {"length": 20, "mult": 2} for Bollinger Bands, {"maType": "EMA", "length": 50} for a moving average. Omitted settings take Vela\'s defaults.',
            ),
            line: z
              .string()
              .max(20)
              .optional()
              .describe("Which line: value (RSI, ATR, moving average, SuperTrend), macd / signal / hist (MACD), basis / upper / lower (Bollinger Bands), k / d (Stochastic). Default: the main line."),
            when: z.enum(["crosses_above", "crosses_below", "crosses", "above", "below"]),
            than: z
              .union([z.number(), z.string().max(20)])
              .describe('What the line is compared with: a number (70), "price" (the closing price), or another line of the same indicator ("signal").'),
          })
          .optional(),
        library: z
          .object({
            slug: z.string().min(1).max(200).describe("The Library indicator's slug, from library_search or library_get_indicator."),
            alert_condition: z
              .string()
              .max(256)
              .optional()
              .describe("The name of one of its alert conditions (as the indicator's alert menu lists it). Omitted: it fires on the indicator's own alerts."),
            settings: z.record(z.string().max(200), z.union([z.number(), z.string().max(2000), z.boolean()])).optional().describe("The indicator's inputs, by name; omitted ones take its defaults."),
          })
          .optional(),
        frequency: frequencyInput.default("once_per_bar_close"),
        min_interval_seconds: minIntervalInput,
        name: z.string().trim().min(1).max(120).optional().describe("The alert's name; default describes the condition."),
        preview_only: z.boolean().optional().describe("Only replay it over history and say how often it would have fired; create nothing."),
      }),
      annotations: WRITE,
    },
    async ({ symbol, timeframe, indicator, library, frequency, min_interval_seconds, name, preview_only }) => {
      if (Boolean(indicator) === Boolean(library)) {
        return textError("Nothing was created: give exactly one of `indicator` (a Vela built-in) or `library` (a Library indicator).");
      }
      const market = parsedMarket(symbol);
      if (isResult(market)) return market;
      const tf = TF_MINUTES[timeframe];
      let condition: Record<string, unknown>;
      let what: string;
      if (indicator) {
        const rhs =
          typeof indicator.than === "number"
            ? { op: "const", value: indicator.than }
            : indicator.than.trim().toLowerCase() === "price"
              ? { op: "src", field: "close" }
              : { op: "native", output: indicator.than.trim() };
        condition = {
          op: "cmp",
          fn: COMPARISONS[indicator.when],
          args: [{ op: "native", ...(indicator.line ? { output: indicator.line } : {}) }, rhs],
        };
        what = `${indicator.type}${indicator.line ? ` ${indicator.line}` : ""} ${COMPARISON_WORDS[indicator.when]} ${indicator.than}`;
      } else {
        condition = { op: "pine", output: library!.alert_condition ? { alertcondition: library!.alert_condition } : { alert: true } };
        what = `${library!.slug}${library!.alert_condition ? ` "${library!.alert_condition}"` : "'s alerts"}`;
      }
      try {
        const answer = await previewAlert({
          draft: {
            type: "agent",
            ...(name ? { name } : {}),
            scope: { kind: "market", market: { source: market.source, symbol: market.symbol } },
            condition,
            frequency: frequencyOf(frequency, timeframe, min_interval_seconds),
            tf,
          },
          ...(library ? { script: { libraryId: library.slug, ...(library.settings ? { inputs: library.settings } : {}) } } : {}),
          ...(indicator ? { native: { type: indicator.type, ...(indicator.settings ? { inputs: indicator.settings } : {}) } } : {}),
        });
        const history = previewWords(answer.preview, tf);
        const chartUrl = marketChartUrl(market, timeframe);
        const ruleName = typeof answer.rule.name === "string" ? answer.rule.name : (name ?? what);
        const previewData =
          answer.preview.status === "ok"
            ? { status: "ok", fires: answer.preview.count, per_day: answer.preview.perDay, days: answer.preview.days, noisy: answer.preview.noisy }
            : { status: "unavailable", reason: answer.preview.reason };
        if (preview_only) {
          return ok(
            `Preview of the Custom Alert "${ruleName}" on ${marketWords(market)}, ${timeframe} bars (nothing was created). ${history}` +
              (chartUrl ? ` The market on Vela: ${chartUrl}` : ""),
            { created: false, name: ruleName, market: marketId(market), timeframe, preview: previewData, ...(chartUrl ? { chart_url: chartUrl } : {}) },
          );
        }
        const channel = await notifyChannel();
        const view = await createAlert({
          ...answer.rule,
          actions: channel.actions.map((a) => ({ ...a, template: answer.defaultTemplate })),
        });
        const v = alertView(view);
        return ok(
          `Created the Custom Alert "${view.rule.name}" (id ${view.rule.id}) on ${marketWords(market)}, ${timeframe} bars; ${v.frequency}. It is ${v.state}. ${history} ${channel.words}` +
            (v.chart_url ? ` The market on Vela: ${v.chart_url}` : ""),
          { created: true, alert: v, preview: previewData, notifies: channel.channel },
        );
      } catch (error) {
        return writeFailure(error, preview_only ? "No preview" : "The Custom Alert was not created");
      }
    },
  );

  const toggle = (action: "pause" | "resume") =>
    async ({ alert_id }: { alert_id: string }) => {
      try {
        const view = await (action === "pause" ? pauseAlert(alert_id) : resumeAlert(alert_id));
        const v = alertView(view);
        return ok(`${action === "pause" ? "Paused" : "Turned back on"}: ${alertSentence(view)}`, { alert: v });
      } catch (error) {
        if (error instanceof AppAuthError || error instanceof AppPermissionError) throw error;
        if (isNotFound(error)) {
          return textError(`No alert with the id "${alert_id}" in this account (or LuxAlgo Alerts are not open on it yet). alerts_list gives the ids.`);
        }
        return writeFailure(error, `The alert was not ${action === "pause" ? "paused" : "turned back on"}`);
      }
    };

  registerProtectedTool(
    server,
    runtime,
    "alerts_pause",
    {
      title: "Pause an alert",
      description: `Pauses one of the signed-in member's alerts (Price Alert or Custom Alert, its id from alerts_list): it stays saved and stops firing until alerts_resume. Returns the alert in words. ${CONFIRM_NOTE}`,
      inputSchema: z.object({ alert_id: alertIdInput }),
      annotations: WRITE,
    },
    toggle("pause"),
  );

  registerProtectedTool(
    server,
    runtime,
    "alerts_resume",
    {
      title: "Turn an alert back on",
      description: `Turns one of the signed-in member's alerts back on (paused, fired, expired or held back by the plan; its id from alerts_list). Returns the alert in words. ${PLAN_NOTE} ${CONFIRM_NOTE}`,
      inputSchema: z.object({ alert_id: alertIdInput }),
      annotations: WRITE,
    },
    toggle("resume"),
  );

  registerProtectedTool(
    server,
    runtime,
    "alerts_history",
    {
      title: "Alert history",
      description:
        "When the signed-in member's alerts fired, newest first (kept 90 days): the alert, the market, the time, and whether each notification was delivered; the price it fired at only for crypto markets fed by an exchange's public feed (Hyperliquid, Binance). Optionally for one alert (`alert_id`). Paged with `cursor`. Use alerts_list for the alerts themselves.",
      inputSchema: z.object({
        alert_id: alertIdInput.optional(),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().max(512).optional().describe("`next_cursor` from the previous page; keep the other arguments identical."),
      }),
      annotations: READ,
    },
    async ({ alert_id, limit, cursor }) => {
      try {
        const { events, nextCursor } = await listAlertEvents({ ruleId: alert_id, cursor, limit });
        const rows = events.map((e) => {
          const price = eventPrice(e.market, e.payload);
          const deliveries = e.deliveries.map((d) => `${d.kind === "inapp" ? "in-app" : (d.kind ?? "a removed channel")}: ${d.status.replace("_", " ")}`);
          return {
            alert_id: e.ruleId,
            alert_name: e.ruleName,
            market: e.market,
            time: e.eventTime,
            ...(price !== undefined ? { price } : {}),
            notifications: deliveries,
          };
        });
        if (rows.length === 0) {
          return ok(`No alert has fired${alert_id ? " for that alert" : ""} in the last 90 days.`, { events: [], next_cursor: null });
        }
        const lines = rows.map(
          (r) =>
            `- ${r.time}: "${r.alert_name ?? "a deleted alert"}" on ${r.market}${r.price !== undefined ? ` at ${r.price}` : ""}; ${r.notifications.length ? r.notifications.join(", ") : "notified no one"}`,
        );
        return ok(`${rows.length} fire${rows.length === 1 ? "" : "s"}, newest first:\n${lines.join("\n")}${nextCursor ? "\nMore: pass next_cursor." : ""}`, {
          events: rows,
          next_cursor: nextCursor,
        });
      } catch (error) {
        return writeFailure(error, "Could not read the alert history");
      }
    },
  );
}

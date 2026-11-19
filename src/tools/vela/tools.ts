/*
  The chart the signed-in member has open in Vela, read and changed by the AI
  assistant they connected: its market, timeframe, chart type, session, scale,
  visible range and layout, a pro's markup found on the chart's own bars, and
  drawings at coordinates the assistant chooses. A markup or a drawing can
  carry a short explanation of each part, and the member is then walked
  through them on the chart, one bubble at a time.

  The app does the work: each tool asks it (POST /api/agents/chart, the
  member's own token), the app passes the ask to the member's visible Vela
  tab, the tab runs it on the live chart and the app hands back what the
  chart shows afterwards, within about twenty seconds. Nothing is kept on
  either side after the answer.

  This is the member's own Vela, not the chart in the chat: chart_open and
  chart_command (tools/chart) show and change a chart inside the conversation,
  and chart_peek (tools/chart/peek.ts) is a picture of the member's Vela chart.

  Results are words: markets, timeframes, indicator names, the dates on
  screen. They carry no bar, for any market, and no price either, except what
  a markup found on a crypto chart fed by an exchange: the app decides that
  (`marked.priced`) and this server only relays it, never adds a price of its
  own. What a plan allows (a custom timeframe, CME futures) is the app's to
  decide too: its 403 goes up to the auth wrapper as it is (docs/auth.md §6).

  Off unless LUXALGO_CHART_CONTROL_TOOLS=on or a Vercel preview
  (_shared/member.ts), and never on the Claude address. While the app's own
  switch for it is off, the route answers 404 and the tools say it is not
  available yet.
*/
import { z } from "zod";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { registerProtectedTool } from "../../auth/protected-tool.js";
import type { AuthRuntime } from "../../auth/runtime.js";
import { AppApiError, AppAuthError, AppPermissionError, appSend } from "../../platform/app-client.js";
import { errorMessage, textError } from "../_shared/result.js";
import { CHART_ORIGIN } from "../_shared/vela.js";

/** Vela's largest grid has 16 charts; the app takes slots 0 to 15. */
const MAX_SLOT = 15;

type ChartScale = { mode?: string; log?: boolean; invert?: boolean };
type ChartReport = {
  slot: number;
  symbol: string;
  timeframe: string;
  chartType?: string;
  session?: string;
  scale?: ChartScale;
  visibleRange: { from: string; to: string } | null;
  indicators: string[];
  clock?: string;
  quantDrawings: number;
};
type ChartState = { layout: string; activeSlot: number | null; charts: ChartReport[] };
type Drawn = { slot?: number; group: string; drawings: number; rejected?: string[] };
type MarkedItem = { label: string; prices?: string[]; time: string; state?: string };
type MarkedConcept = { concept: string; group?: string; summary: string; note?: string; items: MarkedItem[] };
/** What a markup found; `priced` is the app's decision on whether prices may be given for this market. */
type Marked = { slot?: number; priced: boolean; concepts: MarkedConcept[]; drawings: number; truncated?: boolean };
type SyncKind = "symbol" | "timeframe";
export type ChartAnswer =
  | {
      status: "ok";
      state?: ChartState;
      marked?: Marked;
      drawn?: Drawn;
      removed?: number;
      walkthrough?: number;
      releasedSync?: SyncKind[];
    }
  | { status: "queued" }
  | { status: "failed"; error: string; state?: ChartState }
  | { status: "no_open_chart" }
  | { status: "timeout" };

const OPEN_VELA = `${CHART_ORIGIN}/chart`;

const NO_OPEN_CHART = `No Vela chart of the member's is open and visible right now, or their Vela tab has not noticed the assistant yet (the first time, that can take up to a minute), so there is nothing to read. Ask them to open Vela at ${OPEN_VELA}, keep that tab visible, and ask again in a minute.`;

const QUEUED = `Queued, not applied yet: no Vela tab of the member's is on screen right now (they may be in another tab, talking to you). It is waiting for them and is applied the moment they look at their Vela tab, within the next 10 minutes, where they watch it happen; later changes wait behind it, in order. Tell them it is ready and to open Vela at ${OPEN_VELA}. What the chart shows afterwards, and what a markup found, is not known yet: read the chart with vela_read_chart once they are there, and run a markup again then if you need its levels.`;

const CHART_TYPE_WORDS: Record<string, string> = {
  candles: "candles",
  bars: "bars",
  line: "a line",
  area: "an area",
  baseline: "a baseline",
  heikinashi: "Heikin Ashi candles",
  footprint: "a footprint chart",
  tpo: "a TPO profile",
};

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function scaleWords(scale: ChartScale | undefined): string {
  if (!scale) return "";
  const words = [
    scale.mode === "percent" ? "a percent scale" : scale.mode === "indexed" ? "a scale indexed to 100" : "",
    scale.log ? "a logarithmic scale" : "",
    scale.invert ? "an inverted scale" : "",
  ].filter(Boolean);
  return words.length ? `, on ${list(words)}` : "";
}

/** One chart of the layout in a sentence or two: what it shows, never a price. */
function describeChart(chart: ChartReport, many: boolean, active: boolean): string {
  const type = chart.chartType ? `, as ${CHART_TYPE_WORDS[chart.chartType] ?? chart.chartType}` : "";
  const session = chart.session === "extended" ? ", extended hours" : "";
  let text = many ? `Chart ${chart.slot}${active ? " (the one the member is working on)" : ""}: ` : "";
  text += `${chart.symbol}, ${chart.timeframe}${type}${session}${scaleWords(chart.scale)}.`;
  text += chart.indicators.length ? ` Indicators: ${list(chart.indicators)}.` : " No indicators.";
  if (chart.visibleRange) text += ` On screen: ${chart.visibleRange.from.slice(0, 10)} to ${chart.visibleRange.to.slice(0, 10)}.`;
  if (chart.quantDrawings > 0) {
    text += ` ${chart.quantDrawings} drawing${chart.quantDrawings === 1 ? "" : "s"} by Quant or an assistant on it.`;
  }
  if (chart.clock) text += ` Its clock is ${chart.clock}.`;
  return text;
}

/** What the member's Vela shows, in words. */
export function describeState(state: ChartState): string {
  const many = state.charts.length > 1;
  const lines = state.charts.map((chart) => describeChart(chart, many, chart.slot === state.activeSlot));
  return many ? `The member's Vela shows ${state.charts.length} charts (layout ${state.layout}).\n${lines.join("\n")}` : `The member's Vela chart shows ${lines[0] ?? "no market yet."}`;
}

/** How many items of one concept the text names; the structured result carries them all. */
const ITEMS_IN_TEXT = 8;

/** One thing a markup found: its name, its prices when the app gave them, when, and its state. */
function describeItem(item: MarkedItem): string {
  // A label that already cites its price ("EQ (64,200)") is not given it twice.
  const prices = item.prices?.length && !item.prices.some((price) => item.label.includes(price)) ? ` at ${list(item.prices)}` : "";
  return `${item.label}${prices} (${item.time}${item.state ? `, ${item.state}` : ""})`;
}

/** What a markup found, in words. Prices appear only as the app sent them. */
export function describeMarked(marked: Marked): string {
  const lines = marked.concepts.map((found) => {
    const named = found.items.slice(0, ITEMS_IN_TEXT).map(describeItem);
    const more = found.items.length > ITEMS_IN_TEXT ? `, and ${found.items.length - ITEMS_IN_TEXT} more` : "";
    const group = found.group ? ` (group "${found.group}")` : "";
    return `- ${found.summary}${group}${named.length ? `: ${named.join("; ")}${more}` : ""}.${found.note ? ` ${found.note}` : ""}`;
  });
  const drawn = `${marked.drawings} drawing${marked.drawings === 1 ? "" : "s"} on the member's chart`;
  const cut = marked.truncated ? " Only the first drawings of this markup were drawn; ask for fewer concepts or a lower count to see the rest." : "";
  const prices = marked.priced
    ? ""
    : " Prices are not returned for this market: the drawings sit at their exact levels on the member's chart, where they can read them, so refer to them by name and never state or estimate a price.";
  return `Marked up, ${drawn}:\n${lines.join("\n")}\n${cut}${prices}`.trim();
}

/** What the member sees happen after a markup or a drawing that explained its parts. */
const walkthroughWords = (parts: number | undefined): string =>
  parts ? ` The member is now being walked through ${parts === 1 ? "that part" : `those ${parts} parts`} on the chart, one bubble at a time, with your explanation on each.` : "";

/** The state as structured content: the app's report in this server's snake_case. */
function stateContent(state: ChartState | undefined): Record<string, unknown> {
  if (!state) return {};
  return {
    layout: state.layout,
    active_slot: state.activeSlot,
    charts: state.charts.map((chart) => ({
      slot: chart.slot,
      symbol: chart.symbol,
      timeframe: chart.timeframe,
      ...(chart.chartType ? { chart_type: chart.chartType } : {}),
      ...(chart.session ? { session: chart.session } : {}),
      ...(chart.scale ? { scale: chart.scale } : {}),
      visible_range: chart.visibleRange,
      indicators: chart.indicators,
      ...(chart.clock ? { clock: chart.clock } : {}),
      quant_drawings: chart.quantDrawings,
    })),
  };
}

const say = (status: string, text: string, extra: Record<string, unknown> = {}, isError = false): CallToolResult => ({
  content: [{ type: "text", text }],
  structuredContent: { status, ...extra },
  ...(isError ? { isError: true } : {}),
});

/** The app's answer as a tool result; `done` words what an `ok` did. */
function answer(data: ChartAnswer, done: (data: Extract<ChartAnswer, { status: "ok" }>) => string): CallToolResult {
  switch (data.status) {
    case "ok": {
      const lead = done(data);
      const released = data.releasedSync?.length
        ? ` So that each chart keeps its own, the layout's ${data.releasedSync.join(" and ")} link${data.releasedSync.length === 1 ? " is" : "s are"} off (with a link on, a change on one chart applies to all).`
        : "";
      const shows = data.state ? describeState(data.state) : "";
      return say("ok", [lead + walkthroughWords(data.walkthrough) + released, shows].filter(Boolean).join(" "), {
        ...stateContent(data.state),
        ...(data.marked ? { marked: data.marked } : {}),
        ...(data.drawn ? { drawn: data.drawn } : {}),
        ...(data.removed !== undefined ? { removed: data.removed } : {}),
        ...(data.walkthrough ? { walkthrough: data.walkthrough } : {}),
        ...(data.releasedSync?.length ? { released_sync: data.releasedSync } : {}),
      });
    }
    case "queued":
      return say("queued", QUEUED);
    case "failed": {
      const shows = data.state ? ` ${describeState(data.state)}` : "";
      return say("failed", `The chart could not do that: ${data.error}${shows}`, stateContent(data.state), true);
    }
    case "no_open_chart":
      return say("no_open_chart", NO_OPEN_CHART);
    case "timeout":
      return say(
        "timeout",
        "The Vela tab did not answer in time, so it is not known whether the change landed. Read the chart with vela_read_chart in a moment, with the tab open and visible.",
      );
    default:
      return textError("The LuxAlgo app gave an answer this server does not know. Try again in a moment.");
  }
}

/** Errors in words; sign-in and plan answers always go up to the auth wrapper (docs/auth.md §6). */
function failure(error: unknown): CallToolResult {
  if (error instanceof AppAuthError || error instanceof AppPermissionError) throw error;
  if (error instanceof AppApiError && error.status === 404) {
    return textError("Reading and changing the member's open Vela chart is not available yet.");
  }
  if (error instanceof AppApiError && error.status === 429) {
    return textError("Too many chart changes asked for in the last minute. Wait a minute and try again.");
  }
  // A state the chart cannot take (a seconds timeframe, an unknown layout): the app says which and why.
  if (error instanceof AppApiError && error.status === 400) return textError(`Nothing changed: ${error.message}`);
  return textError(`Could not reach the member's chart: ${errorMessage(error)}.`);
}

async function ask(body: Record<string, unknown>, done: (data: Extract<ChartAnswer, { status: "ok" }>) => string) {
  try {
    return answer(await appSend<ChartAnswer>("POST", "/api/agents/chart", { body }), done);
  } catch (error) {
    return failure(error);
  }
}

// ── schemas ──────────────────────────────────────────────────────────────────

const slot = z
  .number()
  .int()
  .min(0)
  .max(MAX_SLOT)
  .optional()
  .describe("One chart of a multi-chart layout, by position (0 is the top-left, in reading order). Leave it out for the chart the member is working on.");

export const CHART_TYPES = ["candles", "bars", "line", "area", "baseline", "heikinashi", "footprint", "tpo"] as const;
export const VISIBLE_RANGE_PRESETS = ["1D", "1W", "1M", "3M", "6M", "1Y", "5Y", "YTD", "ALL"] as const;

const chartPatch = z.object({
  slot,
  symbol: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'The market. Prefer the bare ticker, which Vela resolves across every venue it serves: "AAPL", "SPY", "EURUSD", "XAUUSD" (gold), "BTCUSDT". To pin a venue use PREFIX:TICKER with one of Vela\'s sources only: BINANCE ("BTCUSDT", perpetuals "BTCUSDT.P"), BINANCE.US, COINBASE (dash form, "BTC-USD"), HYPERLIQUID (the base asset only, "BTC"), BYBIT, NASDAQ / NYSE / AMEX / BATS (US stocks and ETFs, "NASDAQ:AAPL"), FX ("EURUSD"), COMMODITIES ("XAUUSD"), CME (futures, always with the prefix: "CME:ES1!"). The ticker must be in that venue\'s own form, and venue prefixes from other charting platforms (OANDA, TVC, FX_IDC) are not read: the result says what the chart shows afterwards, so check it took.',
    ),
  timeframe: z
    .string()
    .min(1)
    .max(12)
    .optional()
    .describe(
      'Any amount from 1 minute up: minutes ("1", "15", "22m"), hours ("1h", "4h"), days ("D", "3D"), weeks ("W", "2W") or months ("M"). Lowercase m is minutes, uppercase M is months; a bare number is minutes. There are no seconds or tick timeframes.',
    ),
  chart_type: z
    .enum(CHART_TYPES)
    .optional()
    .describe('How the price is drawn. "footprint" and "tpo" are the orderflow charts, built from real trades: crypto, US stocks and ETFs and CME futures, not forex or commodities.'),
  session: z.enum(["regular", "extended"]).optional().describe("Trading session, where the market has one (US stocks and futures); ignored elsewhere."),
  scale: z
    .object({
      mode: z.enum(["price", "percent", "indexed"]).optional().describe('"price" is the plain price scale, "percent" the change in percent, "indexed" indexed to 100.'),
      log: z.boolean().optional().describe("Logarithmic price scale."),
      invert: z.boolean().optional().describe("Inverted price scale."),
    })
    .optional()
    .describe("Price scale settings; send only the ones that change."),
  visible_range: z
    .object({
      preset: z.enum(VISIBLE_RANGE_PRESETS).optional().describe("A range ending now."),
      from: z.string().max(40).optional().describe("Start of an exact window, ISO 8601 date or date and time."),
      to: z.string().max(40).optional().describe("End of an exact window, ISO 8601."),
    })
    .optional()
    .describe("The dates on screen: a preset, or from and to together."),
});

type ChartPatchInput = z.infer<typeof chartPatch>;

/** One chart's patch in the app's own names, or why it cannot be sent. */
function toAppPatch(patch: ChartPatchInput): Record<string, unknown> | { error: string } {
  const { chart_type, visible_range, ...rest } = patch;
  let visibleRange: Record<string, string> | undefined;
  if (visible_range) {
    const { preset, from, to } = visible_range;
    if (preset && !from && !to) visibleRange = { preset };
    else if (!preset && from && to) visibleRange = { from, to };
    else return { error: "visible_range takes a preset, or from and to together." };
  }
  const out = { ...rest, ...(chart_type ? { chartType: chart_type } : {}), ...(visibleRange ? { visibleRange } : {}) };
  // A patch that names a chart and changes nothing on it is a mistake worth saying.
  if (Object.keys(out).filter((key) => key !== "slot").length === 0) return { error: "each entry of charts needs at least one thing to change." };
  return out;
}

const chartTime = z.union([z.string().min(4).max(40), z.number()]);
const point = z.object({ time: chartTime, price: z.number() });

export const DRAWING_TYPES = ["level", "zone", "trendline", "path", "channel", "fib", "note", "vline", "position"] as const;
export const DRAWING_TONES = [
  "bullish",
  "bearish",
  "liquidity",
  "neutral",
  "projection",
  "time",
  "gap",
  "demand",
  "supply",
  "range",
  "extension",
  "premium",
  "discount",
] as const;

const explain = z
  .string()
  .max(280)
  .optional()
  .describe(
    "One or two plain sentences on what this part is and why it matters here. With it, the member is walked through the parts on their chart, a bubble on each in turn with Next and Exit: use it whenever you are teaching or presenting an analysis.",
  );

export const MARKUP_CONCEPTS = [
  "fair_value_gaps",
  "liquidity",
  "market_structure",
  "order_blocks",
  "dealing_range",
  "opening_gaps",
  "killzones",
  "macros",
  "key_levels",
  "support_resistance",
  "trendlines",
  "pattern",
  "range",
] as const;

const markupConcept = z.object({
  concept: z
    .enum(MARKUP_CONCEPTS)
    .describe(
      "What to find and draw: fair_value_gaps; liquidity (buyside and sellside, equal highs and lows, sweeps); market_structure (BOS and MSS); order_blocks (and breakers); dealing_range (the range split at equilibrium into premium and discount); opening_gaps (NWOG, NDOG); killzones and macros (ICT session windows, New York time); key_levels (previous day and week high and low, midnight open, session highs and lows); support_resistance; trendlines; pattern (channel, wedge, triangle); range (a range high and low with extensions).",
    ),
  explain,
  count: z.number().int().min(1).max(12).optional().describe("How many to draw, nearest to price first."),
  direction: z.enum(["bullish", "bearish", "both"]).optional().describe("fair_value_gaps: which side."),
  mitigation: z.enum(["full", "ce"]).optional().describe("fair_value_gaps: filled once price trades through the far edge (full, the default) or reaches the 50% CE."),
  include_mitigated: z.boolean().optional().describe("fair_value_gaps: also show the last filled gaps."),
  inversions: z.boolean().optional().describe("fair_value_gaps: mark gaps closed through as inversion FVGs."),
  include_swept: z.boolean().optional().describe("liquidity: show recently swept levels (default true)."),
  strength: z.number().int().min(2).max(50).optional().describe("Swing strength in bars per side (the default suits the timeframe)."),
  breakers: z.boolean().optional().describe("order_blocks: include breaker blocks (default true)."),
  ote: z.boolean().optional().describe("dealing_range: add the OTE band 0.62 / 0.705 / 0.79."),
  quarters: z.boolean().optional().describe("dealing_range: add the 0.25 / 0.75 quarters."),
  high: z.number().optional().describe("dealing_range, range: a range high the member named."),
  low: z.number().optional().describe("dealing_range, range: a range low the member named."),
  leg: z.enum(["up", "down"]).optional().describe("dealing_range: the leg's direction, needed only when a named high or low did not trade on the loaded bars."),
  extensions: z.array(z.number()).max(4).optional().describe("range: extension ratios (default 1.618)."),
  gap_kind: z.enum(["week", "day", "both"]).optional().describe("opening_gaps: NWOG (week, the default), NDOG (day) or both."),
  only: z.array(z.string().max(30)).max(8).optional().describe('killzones, macros: only these windows by name, e.g. ["NY AM"].'),
  windows: z
    .array(z.object({ name: z.string().max(30), start: z.string().max(5), end: z.string().max(5) }))
    .max(8)
    .optional()
    .describe('killzones, macros: your own New York windows, e.g. [{"name":"Macro","start":"09:50","end":"10:10"}].'),
  days: z.number().int().min(0).max(5).optional().describe("killzones, macros: days back to draw (0 is today only)."),
  levels: z
    .array(z.enum(["previous-day", "previous-week", "midnight-open", "sessions"]))
    .max(4)
    .optional()
    .describe("key_levels: which levels (default previous-day and midnight-open)."),
});

const drawing = z.object({
  type: z.enum(DRAWING_TYPES),
  points: z
    .array(point)
    .max(12)
    .optional()
    .describe(
      "Anchor points, each a time and a price. level: 1 (where it starts); zone, fib, trendline: 2 corners; path: 2 to 12 vertices in order; channel: 4 (upper start, upper end, lower start, lower end); note: 1; position: 1 (the entry).",
    ),
  time: chartTime.optional().describe("vline: the time."),
  label: z.string().max(60).optional().describe("A short label shown on the drawing."),
  text: z.string().max(400).optional().describe("note: the text of the card; \\n between lines."),
  tone: z.enum(DRAWING_TONES).optional().describe("The colour role; Vela's house style picks the colour."),
  dash: z.enum(["solid", "dashed", "dotted"]).optional(),
  extend: z.boolean().optional().describe("level, zone, trendline: run to the chart's right edge (a level does by default)."),
  end_time: chartTime.optional().describe("level: where it stops; position: where the box ends."),
  arrow: z.boolean().optional().describe("path, trendline: end in an arrowhead (a path does by default)."),
  stop: z.number().optional().describe("position: the stop price."),
  target: z.number().optional().describe("position: the target price."),
  explain,
});

/** A part's `explain` is the app's `teach`: its bubble in the walkthrough on the chart. */
const withTeach = <T extends { explain?: string }>({ explain: said, ...rest }: T) => ({
  ...rest,
  ...(said?.trim() ? { teach: said.trim() } : {}),
});

const VISIBLE_TAB = "The member's Vela tab must be open and visible; a first ask after a quiet spell can say no chart is open, and asking again a minute later works.";
/** For the tools that change the chart: a change is never lost to a tab that is not on screen. */
const WAITS = "With the member's Vela tab on screen it happens in front of them within seconds. When it is not (they are in another tab), the change is queued and applied the moment they look at Vela again, within 10 minutes: the result then says queued, so tell them to open Vela.";

export function registerVelaChartTools(server: McpServer, runtime: AuthRuntime) {
  registerProtectedTool(
    server,
    runtime,
    "vela_read_chart",
    {
      title: "Read my open Vela chart",
      description:
        `What the signed-in member has open right now in Vela, our next-generation charting platform, in their browser, in words: the layout, and for each chart its market, timeframe, chart type, indicators, the dates on screen and its clock. Use it before changing or drawing on the member's chart, and when they ask what their chart is set to. It changes nothing and carries no prices or candles; for a picture of the chart use chart_peek, and to show a chart inside the chat use chart_open. ${VISIBLE_TAB}`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async () => ask({ op: "read" }, () => ""),
  );

  registerProtectedTool(
    server,
    runtime,
    "vela_set_chart",
    {
      title: "Change my open Vela chart",
      description:
        `Changes the chart the signed-in member has open right now in Vela, in their browser: the market (symbol), the timeframe, the chart type, the trading session, the price scale, the dates on screen, and the multi-chart layout. Send only what should change; everything else on the chart stays, and it never adds or removes an indicator or a drawing. Use it when the member asks to switch their own chart ("put ETH on my chart", "go to the 15 minute", "split it in four"), and before vela_mark_up_chart when the analysis they ask for is of another market or timeframe. The member sees the change happen and is told an assistant made it. Returns what the chart shows afterwards, in words, with no prices: check the market it names is the one asked for. A custom timeframe or a CME futures market the member's plan does not include changes nothing and says which plan limit it is. To show or change a chart inside the chat instead, use chart_open and chart_command. ${WAITS}`,
      inputSchema: z.object({
        layout: z
          .string()
          .max(40)
          .optional()
          .describe(
            'Multi-chart layout: "1" one chart, "2h" two side by side, "2v" two stacked, "4" (2 by 2), "8" (2 by 4), "g<rows>x<cols>" up to 4 each (e.g. "g3x3"), or one big chart with smaller ones: "big-left-2", "big-left-3", "big-right-2", "big-top-2", "big-top-3", "big-bottom-2". A smaller layout closes the charts that no longer fit.',
          ),
        charts: z.array(chartPatch).max(16).optional().describe("Changes per chart, each for one chart of the layout (by slot) or for the chart the member is working on."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ layout, charts }) => {
      if (layout === undefined && !charts?.length) return textError("Nothing changed: send a layout, at least one chart change, or both.");
      const patches: Record<string, unknown>[] = [];
      for (const patch of charts ?? []) {
        const mapped = toAppPatch(patch);
        if ("error" in mapped) return textError(`Nothing changed: ${mapped.error}`);
        patches.push(mapped);
      }
      return ask(
        { op: "set", state: { ...(layout !== undefined ? { layout } : {}), ...(patches.length ? { charts: patches } : {}) } },
        () => "Done.",
      );
    },
  );

  registerProtectedTool(
    server,
    runtime,
    "vela_mark_up_chart",
    {
      title: "Mark up my open Vela chart",
      description:
        `Marks up the chart the signed-in member has open right now in Vela the way a professional discretionary trader would, from the chart's own candles: fair value gaps, buyside and sellside liquidity and equal highs and lows, market structure (BOS and MSS), order blocks and breakers, the dealing range with premium, discount and OTE, opening gaps, ICT killzones and macros, key levels (previous day and week high and low, midnight open, session highs and lows), support and resistance, trendlines, chart patterns, and a range with extensions. You name the concepts and Vela finds the exact prices and times itself, so never pass prices you made up; the member watches each one being drawn, as real, labelled drawings in Vela's house style. Use it whenever the member asks to mark up, annotate or analyse their chart, or to be shown where something is on it; it works on every market Vela charts (stocks, futures, forex, crypto), and a new markup of a concept replaces your earlier one. Give each concept an explain and the member is walked through the markup on their chart, your words in a bubble on each part: the way to teach a setup. Returns what was found, each with its time and state; with exact prices for a crypto chart fed by an exchange (Binance, Binance.US, Coinbase, Hyperliquid), and without prices for any other market, where the drawings still sit at their exact levels for the member to read. For drawings at prices you choose yourself (a scenario, a target, a plan) use vela_draw_on_chart. ${WAITS}`,
      inputSchema: z.object({
        slot,
        concepts: z.array(markupConcept).min(1).max(6).describe("What to mark up, up to six concepts in one go."),
        replace: z.boolean().optional().describe("Remove the earlier markup of the same concepts first (default true), so a redraw never stacks."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ slot: chartSlot, concepts, replace }) =>
      ask(
        {
          op: "markup",
          markup: {
            ...(chartSlot !== undefined ? { slot: chartSlot } : {}),
            concepts: concepts.map(withTeach),
            ...(replace !== undefined ? { replace } : {}),
          },
        },
        ({ marked }) => (marked ? describeMarked(marked) : "Marked up."),
      ),
  );

  registerProtectedTool(
    server,
    runtime,
    "vela_draw_on_chart",
    {
      title: "Draw on my open Vela chart",
      description:
        `Draws on the chart the signed-in member has open right now in Vela, at times and prices you give: horizontal levels, shaded zones, trendlines, projection paths with an arrowhead, channels, Fibonacci retracements, text notes, vertical time lines and long or short positions with a stop and a target. Use it to put a plan, a scenario or a target on the member's own chart; for levels and concepts the candles define (fair value gaps, liquidity, key levels and the like) use vela_mark_up_chart, which finds the exact prices itself. The drawings appear as real, labelled drawings in Vela's house style, the member watches them being drawn, and their own drawings are never touched. Give a drawing an explain and the member is walked through the drawings on their chart, your words in a bubble on each. Times are on the chart's clock ("YYYY-MM-DD HH:MM", the clock vela_read_chart names), or ISO 8601 with an offset. It reads no prices: draw at prices the member gave or that a markup returned, never at guessed ones. Returns the group its drawings belong to, which vela_remove_drawings takes. ${WAITS}`,
      inputSchema: z.object({
        slot,
        title: z.string().max(60).optional().describe('What this set of drawings is, e.g. "Bullish scenario to 2,920".'),
        drawings: z.array(drawing).min(1).max(30),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ drawings, ...rest }) =>
      ask({ op: "draw", drawing: { ...rest, drawings: drawings.map(withTeach) } }, ({ drawn }) => {
        if (!drawn) return "Drawn.";
        const rejected = drawn.rejected?.length ? ` Not drawn: ${drawn.rejected.join(" ")}` : "";
        return `Drew ${drawn.drawings} drawing${drawn.drawings === 1 ? "" : "s"} on the member's chart, as group "${drawn.group}" (vela_remove_drawings takes it).${rejected}`;
      }),
  );

  registerProtectedTool(
    server,
    runtime,
    "vela_remove_drawings",
    {
      title: "Remove drawings from my open Vela chart",
      description:
        `Removes drawings an assistant or Quant, our coding agent, made on the chart the signed-in member has open right now in Vela: the groups named (a group vela_mark_up_chart or vela_draw_on_chart returned), or all of them. It never touches the member's own drawings. Use it to clear an analysis before drawing a new one, or when the member asks to clean up what was drawn for them. ${WAITS}`,
      inputSchema: z.object({
        slot,
        groups: z.array(z.string().max(40)).max(20).optional().describe("Groups to remove, as vela_mark_up_chart or vela_draw_on_chart returned them."),
        all: z.boolean().optional().describe("Remove every drawing an assistant or Quant made on the chart."),
        all_charts: z.boolean().optional().describe("Do it on every chart of the layout, not only one."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (input) => {
      if (!input.all && !input.groups?.length) return textError("Nothing removed: name the groups to remove, or set all.");
      return ask({ op: "remove", removal: input }, ({ removed }) =>
        removed ? `Removed ${removed} drawing${removed === 1 ? "" : "s"}.` : "No drawing of an assistant or Quant matched, so nothing was removed; the member's own drawings are never touched.",
      );
    },
  );
}

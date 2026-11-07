/*
  Live Vela charts inside the chat (MCP Apps, SEP-1865 / ext-apps
  2026-01-26). SPIKE: registered only when LUXALGO_CHART_TOOLS=on (see
  ./index.ts and server/manifest.ts).

    chart_open      model-visible; renders ui://vela/chart with the requested
                    market, indicators, levels, zones and range
    chart_command   model-visible; edits an open chart (queued in the app's
                    chart session or in memory, see ./backend.ts; picked up
                    by the view, acknowledged within ~5 s), or reads it
                    ({op: "read"}, optionally with a snapshot for the model)
    chart_sync      app-only (_meta.ui.visibility ["app"]); the view's poll:
                    acknowledges ops, reports its state, answers snapshots,
                    and says when to poll next (`next_poll_ms`)

  Never on the Claude address (./index.ts). Polling is adaptive (view/chart/
  main.ts): about every second while something happens on the chart, every
  ~6 s when it is idle, not at all while it is hidden or out of view. The
  view announces its next poll on each chart_sync and chart_sync answers with
  `next_poll_ms`, fast for 30 s after the model's last chart_command on that
  chart (./local.ts). chart_command waits for the view only when its next
  poll is near; when it is far off it answers at once that the change is
  queued and when the chart applies it.

  The view (view/chart/main.ts, bundled by scripts/build-chart-view.mjs into
  one self-contained HTML document) streams candles straight from the
  exchanges in the user's browser. This server never sees bars, and no tool
  result carries any. Results describe the chart in words; for a market fed
  by an exchange's public feed (market.ts, numbersAllowedFor) they also carry
  a few numbers the view read off the chart: the last price, the day's
  change, the visible high and low and each indicator's latest value.
*/
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { currentSurface } from "../../auth/surface.js";
import { ok, textError } from "../_shared/result.js";
import {
  NATIVE_INDICATORS,
  NATIVE_INDICATOR_KEYS,
  RANGE_PRESETS,
  TIMEFRAME_KEYS,
  marketWords,
  parseMarket,
  rangeWords,
  timeframeWords,
  velaChartUrl,
  type Market,
  type Timeframe,
} from "./market.js";
import { AppAuthError, AppPermissionError } from "../../platform/app-client.js";
import { VIEW_META_KEY, openChart, storeFor } from "./backend.js";
import type { ChartOp, ChartStore, ViewState } from "./store.js";
import { describeNumbers, pickNumbers, withoutNumbers, type ChartNumbers } from "./numbers.js";
import {
  answerSnapshot,
  freshNumbers,
  pendingSnapshot,
  pollSchedule,
  recentCommand,
  recordCommand,
  recordPoll,
  rememberNumbers,
  requestSnapshot,
  waitForSnapshot,
  type SnapshotOutcome,
} from "./local.js";
import { FAST_POLL_MS, SLOW_POLL_MS } from "./polling.js";

export const CHART_RESOURCE_URI = "ui://vela/chart";

/**
 * Every origin the bundled providers talk to (read from @luxalgo/vela 0.10.1
 * providers/hyperliquid.js and providers/binance.js). Binance falls back to
 * binance.us when binance.com is geo-blocked, and ".P" tickers use futures.
 */
export const CHART_CONNECT_DOMAINS = [
  "https://api.hyperliquid.xyz",
  "wss://api.hyperliquid.xyz",
  "https://api.binance.com",
  "https://api.binance.us",
  "https://fapi.binance.com",
  "wss://stream.binance.com:9443",
  "wss://stream.binance.us:9443",
  "wss://fstream.binance.com",
];
/** Coin icons in the legend and symbol search (providers' resolveSymbolIcon). */
export const CHART_RESOURCE_DOMAINS = ["https://crypto-icons.ledger.com"];

/**
 * A stable sandbox origin. The format is host-specific (spec: "Servers MUST
 * consult host-specific documentation"):
 *   - Claude: sha256 of the MCP server URL the user connected, as
 *     `<hash>.claudemcpcontent.com` (kept for when the chart tools reach the
 *     Claude address; ./index.ts keeps them off it today);
 *   - ChatGPT: an origin (`https://…`), unique per plugin, required only when
 *     a plugin with UI is submitted; left out here so ChatGPT uses its default
 *     sandbox until the submission sets one;
 *   - any other client: left out.
 * LUXALGO_CHART_APP_DOMAIN overrides it everywhere, "none" leaves it out. The
 * exchange APIs answer CORS with "*", so nothing depends on it today.
 */
function appDomain(): string | undefined {
  const override = process.env.LUXALGO_CHART_APP_DOMAIN;
  if (override === "none") return undefined;
  if (override) return override;
  const surface = currentSurface();
  if (surface.kind !== "claude") return undefined;
  const hash = createHash("sha256").update(surface.resource).digest("hex").slice(0, 32);
  return `${hash}.claudemcpcontent.com`;
}

/** Where "Open in Vela" may send the user (ChatGPT's link allowlist; the chart link passes through the app host first). */
const OPEN_LINK_DOMAINS = ["https://vela.luxalgo.com", "https://app.luxalgo.com"];

/**
 * The built view (npm run build:chart; Vercel runs it in vercel-build). Two layouts: dist/tools/chart/tools.js
 * next to dist/chart/ (node entries), and src/tools/chart/tools.ts run from source
 * (Vercel bundles api/server.ts from src/). Literal `new URL(…, import.meta.url)` so
 * Vercel's file tracing can see the asset; to be verified on a preview deployment.
 */
const VIEW_CANDIDATES = [
  new URL("../../chart/vela-chart.html", import.meta.url),
  new URL("../../../dist/chart/vela-chart.html", import.meta.url),
];

let cachedHtml: string | undefined;
function viewHtml(): string {
  if (cachedHtml !== undefined) return cachedHtml;
  for (const candidate of VIEW_CANDIDATES) {
    try {
      cachedHtml = readFileSync(candidate, "utf8");
      return cachedHtml;
    } catch {
      // try the next layout
    }
  }
  // Not cached: a later build can still provide it without a restart.
  return "<!doctype html><meta charset=utf-8><p>The chart view is not built. Run <code>npm run build:chart</code>.</p>";
}

const levelSchema = z.object({
  price: z.number().positive().describe("Price of the horizontal level."),
  label: z.string().max(40).optional().describe("Short label shown on the line, e.g. \"Resistance\"."),
});
const zoneSchema = z.object({
  low: z.number().positive(),
  high: z.number().positive(),
  label: z.string().max(40).optional().describe("Short label shown in the zone, e.g. \"Demand\"."),
});

const opSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set_market"),
    symbol: z.string().max(40).optional().describe('New symbol, e.g. "ETH", "hyperliquid:SOL", "binance:ETHUSDT".'),
    timeframe: z.enum(TIMEFRAME_KEYS).optional(),
  }),
  z.object({ op: z.literal("add_indicator"), name: z.enum(NATIVE_INDICATOR_KEYS) }),
  z.object({ op: z.literal("remove_indicator"), name: z.enum(NATIVE_INDICATOR_KEYS) }),
  z.object({ op: z.literal("add_level"), price: z.number().positive(), label: z.string().max(40).optional() }),
  z.object({
    op: z.literal("add_zone"),
    low: z.number().positive(),
    high: z.number().positive(),
    label: z.string().max(40).optional(),
  }),
  z.object({ op: z.literal("clear_drawings") }),
  z.object({ op: z.literal("zoom"), range: z.enum(RANGE_PRESETS) }),
  z.object({
    op: z.literal("read"),
    image: z
      .boolean()
      .optional()
      .describe("Also send a picture of the chart as the user sees it into your context (only where the chat app accepts images from the chart)."),
  }),
]);

const price = z.number().positive().max(1e15);
const indicatorValuesSchema = z
  .array(
    z.object({
      name: z.string().max(60),
      values: z.record(z.string().max(40), z.number().min(-1e15).max(1e15)).refine((v) => Object.keys(v).length <= 10, "at most 10 lines"),
    }),
  )
  .max(30);

const viewStateSchema = z
  .object({
    symbol: z.string().max(60).optional(),
    timeframe: z.string().max(10).optional(),
    range: z.object({ from: z.string().max(40), to: z.string().max(40) }).optional(),
    indicators: z.array(z.string().max(60)).max(30).optional(),
    levels: z.array(levelSchema).max(50).optional(),
    zones: z.array(zoneSchema).max(50).optional(),
    other_drawings: z.number().int().min(0).max(10_000).optional(),
    theme: z.string().max(10).optional(),
    display_mode: z.string().max(12).optional(),
    candles_loaded: z.boolean().optional(),
    error: z.string().max(200).optional(),
    // Numbers, for a market whose numbers the model may read (numbersAllowedFor); dropped for any other.
    last_price: price.optional(),
    change_pct: z.number().min(-100).max(1e6).optional(),
    visible_high: price.optional(),
    visible_low: price.optional(),
    indicator_values: indicatorValuesSchema.optional(),
  })
  .describe("State of the view: words, plus a few numbers (never bars) for an exchange-fed market.");

const snapshotAnswerSchema = z.object({
  id: z.number().int().min(1),
  outcome: z.enum(["sent", "unsupported", "words_only", "failed"]),
  width: z.number().int().min(0).max(10_000).optional(),
  height: z.number().int().min(0).max(10_000).optional(),
  bytes: z.number().int().min(0).max(10_000_000).optional(),
  reason: z.string().max(200).optional(),
});

function list(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function describeLevels(levels: Array<{ price: number; label?: string }>): string {
  return levels.map((l) => (l.label ? `${l.label} at ${l.price}` : `a level at ${l.price}`)).join(", ");
}

function describeZones(zones: Array<{ low: number; high: number; label?: string }>): string {
  return zones.map((z) => `${z.label ?? "a zone"} from ${z.low} to ${z.high}`).join(", ");
}

/** The view's market, parsed (undefined when it reported none or one we do not know). */
function viewMarket(view: ViewState): Market | undefined {
  const market = view.symbol ? parseMarket(view.symbol) : undefined;
  return market && !("error" in market) ? market : undefined;
}

/** Whether the model may receive numbers for the market a view shows (decided by market.ts, numbersAllowedFor). */
export function viewNumbersAllowed(view: ViewState): boolean {
  return viewMarket(view)?.numbersAllowed === true;
}

/** The view's report with its numbers only when its market allows them. */
export function gateNumbers(view: ViewState): ViewState {
  return viewNumbersAllowed(view) ? view : withoutNumbers(view);
}

/** The view's own report, in words (its symbol is "venue:TICKER", its timeframe the short key), with the allowed numbers. */
export function describeView(view: ViewState): string {
  const parts: string[] = [];
  const market = view.symbol ? parseMarket(view.symbol) : undefined;
  const marketText = market && !("error" in market) ? marketWords(market) : view.symbol;
  const tf = view.timeframe && (TIMEFRAME_KEYS as string[]).includes(view.timeframe) ? timeframeWords(view.timeframe as never) : view.timeframe;
  parts.push(`The chart shows ${[marketText, tf].filter(Boolean).join(", ")}`);
  if (view.range) parts.push(`from ${view.range.from} to ${view.range.to}`);
  let text = parts.join(" ") + ".";
  text += view.indicators?.length ? ` Indicators: ${list(view.indicators)}.` : " No indicators.";
  if (view.levels?.length) text += ` Levels: ${describeLevels(view.levels)}.`;
  if (view.zones?.length) text += ` Zones: ${describeZones(view.zones)}.`;
  if (view.other_drawings) text += ` The user has ${view.other_drawings} other drawing${view.other_drawings === 1 ? "" : "s"} on it.`;
  if (view.candles_loaded === false) text += " Candles are still loading.";
  const numbers = viewNumbersAllowed(view) ? pickNumbers(view) : undefined;
  if (numbers) text += ` ${describeNumbers(numbers)}`;
  if (view.error) text += ` The chart reported a problem: ${view.error}.`;
  return text;
}

/** A store's last report with the numbers its view reported recently (./local.ts), when its market allows them. */
function withLocalNumbers(store: ChartStore, view: ViewState | undefined): ViewState | undefined {
  if (!view) return undefined;
  const words = withoutNumbers(view);
  if (!viewNumbersAllowed(words)) return words;
  const numbers = freshNumbers(store.key, { symbol: words.symbol, timeframe: words.timeframe });
  return numbers ? { ...words, ...numbers } : words;
}

/** What chart_command says about a snapshot request. */
function describeSnapshot(answer: SnapshotOutcome | undefined): string {
  if (!answer) return "The chart did not answer the request for a picture (it may be closed or off screen), so there is none.";
  switch (answer.outcome) {
    case "sent":
      return "A picture of the chart as the user sees it was sent to your context; the chat app passes it on with the next message.";
    case "unsupported":
      return "This chat app does not take pictures from the chart, so there is none; the description above is what the chart shows.";
    case "words_only":
      return "This market is described in words only, so there is no picture.";
    default:
      return `The chart could not take a picture${answer.reason ? ` (${answer.reason})` : ""}.`;
  }
}

/** The plain Vela link for the market a view reports (never the session's follow link). */
function linkFor(view: ViewState): string | undefined {
  const market = view.symbol ? parseMarket(view.symbol) : undefined;
  const tf = view.timeframe as Timeframe | undefined;
  if (!market || "error" in market || !tf || !(TIMEFRAME_KEYS as string[]).includes(tf)) return undefined;
  return velaChartUrl(market, tf);
}

/** How long chart_command waits for the view to confirm edits when this process does not know its poll schedule (as before). */
const ACK_WAIT_MS = 5_000;
/** chart_command never waits longer than this for the view's next poll; a poll further off is not waited for. */
const ACK_WAIT_MAX_MS = 8_000;
/** Time for the view to apply the ops and acknowledge after the poll that hands them over. */
const ACK_GRACE_MS = 1_500;

/** `pollInMs`: the view polls too far off to wait for, in this many ms. */
type AckWait = { waitMs: number; pollInMs?: number };

/**
 * How long chart_command waits for the view: as before when the schedule is
 * unknown or the view polls fast; until just after its next poll when that is
 * a few seconds off; not at all when the view stopped polling (hidden or out of
 * view) or its next poll is further off than ACK_WAIT_MAX_MS.
 */
function ackWait(key: string): AckWait {
  const schedule = pollSchedule(key);
  if (schedule.kind === "unknown") return { waitMs: ACK_WAIT_MS };
  if (schedule.kind === "stopped") return { waitMs: 0 };
  const needed = schedule.inMs + ACK_GRACE_MS;
  return needed <= ACK_WAIT_MAX_MS ? { waitMs: Math.max(ACK_WAIT_MS, needed) } : { waitMs: 0, pollInMs: schedule.inMs };
}

/** Asks the view for a picture of the chart (an exchange-fed market only) and waits for its answer. */
async function takeSnapshot(store: ChartStore, view: ViewState | undefined): Promise<SnapshotOutcome | undefined> {
  if (view && !viewNumbersAllowed(view)) return { outcome: "words_only" };
  const id = requestSnapshot(store.key);
  // The request reaches the view on its next poll and the answer on the one after (right away).
  const schedule = pollSchedule(store.key);
  const waitMs =
    schedule.kind === "stopped" ? 0 : schedule.kind === "due" ? Math.max(6_000, Math.min(schedule.inMs + 2_500, 9_000)) : 6_000;
  return waitForSnapshot(store.key, id, waitMs);
}

/** chart_command with only read ops: the chart's last report, its live numbers and, on request, a picture. */
async function readChart(store: ChartStore, chartId: string, wantsImage: boolean, started: number) {
  // Version 0 is always acknowledged: this returns the latest report at once.
  const { view: reported } = await store.waitForAck(0, 0);
  const view = withLocalNumbers(store, reported);
  if (!view) {
    return ok("The chart has not reported what it shows yet (it may still be loading, closed or off screen). Try again in a moment.", {
      chart_id: chartId,
      applied: false,
      view: null,
    });
  }
  const live = pickNumbers(view) !== undefined;
  let text = describeView(view);
  if (!live && viewNumbersAllowed(view)) text += " No live numbers: the chart has not reported recently (it may be closed or off screen).";
  let snapshot: SnapshotOutcome | undefined;
  if (wantsImage) {
    snapshot = await takeSnapshot(store, view);
    text += ` ${describeSnapshot(snapshot)}`;
  }
  if (linkFor(view)) text += ` The chart on Vela: ${linkFor(view)}`;
  return ok(text, {
    chart_id: chartId,
    applied: true,
    waited_ms: Date.now() - started,
    view,
    ...(wantsImage ? { snapshot: snapshot?.outcome ?? "no_answer" } : {}),
  });
}

export function registerChartTools(server: McpServer) {
  const domain = appDomain();
  registerAppResource(
    server,
    "Vela chart",
    CHART_RESOURCE_URI,
    {
      description: "A live Vela chart: candles streamed from the exchange in the browser, indicators, levels and zones.",
    },
    async () => ({
      contents: [
        {
          uri: CHART_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: viewHtml(),
          _meta: {
            ui: {
              csp: { connectDomains: CHART_CONNECT_DOMAINS, resourceDomains: CHART_RESOURCE_DOMAINS },
              ...(domain ? { domain } : {}),
              prefersBorder: true,
            },
            // ChatGPT reads link targets for openExternal/ui/open-link only from its own key.
            "openai/widgetCSP": {
              connect_domains: CHART_CONNECT_DOMAINS,
              resource_domains: CHART_RESOURCE_DOMAINS,
              redirect_domains: OPEN_LINK_DOMAINS,
            },
          },
        },
      ],
    }),
  );

  registerAppTool(
    server,
    "chart_open",
    {
      title: "Vela chart",
      description:
        "Shows an interactive live chart from Vela, our next-generation charting platform, inside the chat: crypto candles streamed from Hyperliquid or Binance in the user's browser, with optional native indicators, horizontal levels, shaded zones and a date range. Use it when the user wants to see or discuss a crypto market visually. Returns a chart_id; change or read the open chart afterwards with chart_command rather than opening a new one. This result describes the chart in words and carries no prices; once the chart is on screen, chart_command (including its read op) also returns the last price, the day's change, the visible high and low and each indicator's latest value. It never returns candles. Symbols: \"BTC\" or \"hyperliquid:BTC\" (Hyperliquid perpetuals), \"binance:BTCUSDT\" (Binance spot); a bare pair ending in USDT/USDC goes to Binance.",
      inputSchema: z.object({
        symbol: z.string().max(40).describe('e.g. "BTC", "hyperliquid:ETH", "binance:BTCUSDT".'),
        timeframe: z.enum(TIMEFRAME_KEYS).default("4h").describe("Candle timeframe."),
        indicators: z.array(z.enum(NATIVE_INDICATOR_KEYS)).max(5).optional().describe("Native indicators to add."),
        levels: z.array(levelSchema).max(20).optional().describe("Horizontal levels to draw."),
        zones: z.array(zoneSchema).max(10).optional().describe("Price zones to shade."),
        range: z.enum(RANGE_PRESETS).optional().describe("Visible date range, ending on the newest candle."),
      }),
      annotations: { title: "Vela chart", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: {
        ui: { resourceUri: CHART_RESOURCE_URI },
        // Older ChatGPT clients read the template from here.
        "openai/outputTemplate": CHART_RESOURCE_URI,
        // ChatGPT's status line while the tool runs and once it is done (64 characters at most).
        "openai/toolInvocation/invoking": "Opening the Vela chart",
        "openai/toolInvocation/invoked": "Vela chart ready",
      },
    },
    async ({ symbol, timeframe, indicators, levels, zones, range }) => {
      const market = parseMarket(symbol);
      if ("error" in market) return textError(`Cannot open the chart: ${market.error}.`);
      const badZone = zones?.find((z) => z.low >= z.high);
      if (badZone) return textError(`Cannot open the chart: a zone's low (${badZone.low}) must be below its high (${badZone.high}).`);
      const opened = await openChart();
      const chartId = opened.chartId;
      const words = [
        `Opened a live chart of ${marketWords(market)}, ${timeframeWords(timeframe)}`,
        indicators?.length ? `with ${list(indicators.map((i) => NATIVE_INDICATORS[i]))}` : "",
        levels?.length ? `levels: ${describeLevels(levels)}` : "",
        zones?.length ? `zones: ${describeZones(zones)}` : "",
        range ? `showing ${rangeWords(range)}` : "",
      ].filter(Boolean);
      const text =
        `${words.join("; ")}. The candles stream from the exchange in the user's browser; this result carries no prices. ` +
        `To change this chart, call chart_command with chart_id "${chartId}". The same chart on Vela: ${velaChartUrl(market, timeframe)}`;
      const result = ok(text, {
        chart_id: chartId,
        symbol: market.symbol,
        venue: market.venue,
        ticker: market.ticker,
        timeframe,
        indicators: indicators ?? [],
        levels: levels ?? [],
        zones: zones ?? [],
        range: range ?? null,
        chart_url: velaChartUrl(market, timeframe),
      });
      // The session's read key and follow link go to the view only (_meta), never to the model.
      return { ...result, _meta: { ui: { resourceUri: CHART_RESOURCE_URI }, ...(opened.view ? { [VIEW_META_KEY]: opened.view } : {}) } };
    },
  );

  server.registerTool(
    "chart_command",
    {
      title: "Vela chart change",
      description:
        "Edits or reads a chart already open in the chat (from chart_open): switch market or timeframe, add or remove a native indicator, draw a level or a zone, clear drawings, or zoom to a date range; {op: \"read\"} changes nothing and returns what the chart shows now. Ops apply in order. Usually waits a few seconds for the chart to confirm and returns what it shows, in words, with the numbers the user sees on it: the last price, the change since the day's open (00:00 UTC), the high and low of the visible range and each indicator's latest value (e.g. \"RSI 38.2\"). Quote those as of the moment of the reply; it never returns candles. {op: \"read\", image: true} also sends a picture of the chart as the user sees it into your context, where the chat app accepts images from the chart (it arrives with the next message). If the chart is idle it may answer at once that the edits are queued and when the chart applies them; if it is not on screen, edits stay queued and apply when it is shown again, and a read returns its last report without live numbers. Use chart_open instead to show a new chart.",
      inputSchema: z.object({
        chart_id: z.string().max(200).describe("The chart_id chart_open returned."),
        ops: z.array(opSchema).min(1).max(20),
      }),
      annotations: { title: "Vela chart change", readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: {
        "openai/toolInvocation/invoking": "Changing the chart",
        "openai/toolInvocation/invoked": "Chart updated",
      },
    },
    async ({ chart_id, ops }) => {
      const store = storeFor(chart_id);
      if (!store) {
        return textError(`No open chart has the id "${chart_id}" (it may have expired). Call chart_open to show a new chart.`);
      }
      // A read is answered here and never queued: the app's chart session takes edits only.
      const wantsImage = ops.some((op) => op.op === "read" && op.image === true);
      const normalized: ChartOp[] = [];
      for (const op of ops) {
        if (op.op === "read") {
          continue;
        } else if (op.op === "set_market") {
          let market: Market | undefined;
          if (op.symbol) {
            const parsed = parseMarket(op.symbol);
            if ("error" in parsed) return textError(`Nothing changed: ${parsed.error}.`);
            market = parsed;
          }
          if (!market && !op.timeframe) return textError("Nothing changed: set_market needs a symbol, a timeframe or both.");
          normalized.push({ op: "set_market", symbol: market?.symbol, timeframe: op.timeframe });
        } else if (op.op === "add_zone" && op.low >= op.high) {
          return textError(`Nothing changed: a zone's low (${op.low}) must be below its high (${op.high}).`);
        } else {
          normalized.push(op);
        }
      }
      try {
        const started = Date.now();
        // The model is at work on this chart: its view polls fast for a while (chart_sync's next_poll_ms).
        recordCommand(store.key);
        if (!normalized.length) return await readChart(store, chart_id, wantsImage, started);
        const pushed = await store.push(normalized);
        if ("gone" in pushed) return textError(`No open chart has the id "${chart_id}". Call chart_open to show a new chart.`);
        if ("refused" in pushed) return textError(`Nothing changed: ${pushed.refused}.`);
        const seq = pushed.version;
        const wait = ackWait(store.key);
        const acked = await store.waitForAck(seq, wait.waitMs);
        const applied = acked.applied;
        const view = withLocalNumbers(store, acked.view);
        const changes = `${normalized.length} change${normalized.length === 1 ? "" : "s"}`;
        const queued =
          wait.pollInMs !== undefined
            ? `Queued ${changes}: the chart is idle and applies them at its next check for changes, within about ${Math.ceil((wait.pollInMs + ACK_GRACE_MS) / 1000)} seconds.`
            : `Queued ${changes}: the chart has not confirmed yet (it may be closed or off screen), so they apply when it is next shown.`;
        let text = applied
          ? `Done. ${view ? describeView(view) : ""}`.trim()
          : queued + (view ? ` Last report: ${describeView(view)}` : "") + (view && linkFor(view) ? ` The chart on Vela: ${linkFor(view)}` : "");
        let snapshot: SnapshotOutcome | undefined;
        if (wantsImage) {
          snapshot = applied ? await takeSnapshot(store, view) : undefined;
          text += ` ${describeSnapshot(snapshot)}`;
        }
        return ok(text, {
          chart_id,
          applied,
          seq,
          waited_ms: Date.now() - started,
          view: view ?? null,
          ...(wantsImage ? { snapshot: snapshot?.outcome ?? "no_answer" } : {}),
        });
      } catch (error) {
        if (error instanceof AppAuthError || error instanceof AppPermissionError) throw error;
        return textError(`Could not reach the chart: ${(error as Error).message}. Try again, or call chart_open to show a new chart.`);
      }
    },
  );

  registerAppTool(
    server,
    "chart_sync",
    {
      title: "Chart view sync",
      description:
        "Used by the chart view itself, not by the model: acknowledges applied changes, reports the chart's state in words and fetches pending changes.",
      inputSchema: z.object({
        chart_id: z.string().max(200),
        sync_key: z.string().max(200).optional().describe("The view's key for an app chart session (from chart_open's _meta)."),
        acked_seq: z.number().int().min(0),
        state: viewStateSchema.optional(),
        next_poll_ms: z
          .number()
          .int()
          .min(0)
          .max(600_000)
          .optional()
          .describe("When the view plans to poll next, in ms, unless the answer's next_poll_ms is sooner (a view that leaves it out polls about every second)."),
        paused: z.boolean().optional().describe("True on the view's last poll before it stops (hidden or out of view) until it is shown again."),
        snapshot_answer: snapshotAnswerSchema.optional().describe("The view's answer to the snapshot request chart_sync last handed it."),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      _meta: {
        // No resourceUri: a host must not render a second view for the poll.
        ui: { visibility: ["app"] },
        // Older ChatGPT clients: callable from the widget, hidden from the model.
        "openai/widgetAccessible": true,
        "openai/visibility": "private",
      },
    },
    async ({ chart_id, sync_key, acked_seq, state, next_poll_ms, paused, snapshot_answer }) => {
      const store = storeFor(chart_id, sync_key);
      let synced: Awaited<ReturnType<ChartStore["sync"]>> | undefined;
      try {
        // The store keeps words; the numbers stay in this process (./local.ts), and only for a market that allows them.
        synced = await store?.sync(acked_seq, state ? withoutNumbers(state) : undefined);
      } catch (error) {
        if (error instanceof AppAuthError || error instanceof AppPermissionError) throw error;
        return textError(`sync failed: ${(error as Error).message}`);
      }
      if (!synced || !store) return ok("unknown chart", { known: false, ops: [] });
      // Past this point the view proved it holds this chart (its key, or this process's memory chart).
      if (state) {
        const allowed = gateNumbers(state);
        rememberNumbers(store.key, pickNumbers(allowed as ChartNumbers), { symbol: state.symbol, timeframe: state.timeframe });
      }
      if (snapshot_answer) {
        const { id, outcome, width, height, bytes, reason } = snapshot_answer;
        answerSnapshot(
          store.key,
          id,
          outcome === "sent" ? { outcome, width: width ?? 0, height: height ?? 0, bytes: bytes ?? 0 } : { outcome, ...(reason ? { reason } : {}) },
        );
      }
      const snapshot = pendingSnapshot(store.key);
      // Fast while there is work for the view or the model used chart_command on this chart lately; slow otherwise.
      const nextPollMs = synced.ops.length || snapshot || recentCommand(store.key) ? FAST_POLL_MS : SLOW_POLL_MS;
      recordPoll(store.key, paused ? null : Math.min(next_poll_ms ?? FAST_POLL_MS, nextPollMs));
      return ok(`${synced.ops.length} pending`, {
        known: true,
        ops: synced.ops,
        ...(snapshot ? { snapshot } : {}),
        next_poll_ms: nextPollMs,
      });
    },
  );
}

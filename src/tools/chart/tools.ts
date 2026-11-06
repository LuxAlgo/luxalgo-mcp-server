/*
  Live Vela charts inside the chat (MCP Apps, SEP-1865 / ext-apps
  2026-01-26). SPIKE: registered only when LUXALGO_CHART_TOOLS=on (see
  ./index.ts and server/manifest.ts).

    chart_open      model-visible; renders ui://vela/chart with the requested
                    market, indicators, levels, zones and range
    chart_command   model-visible; edits an open chart (queued in ./store.ts,
                    picked up by the view, acknowledged within ~5 s)
    chart_sync      app-only (_meta.ui.visibility ["app"]); the view's poll:
                    acknowledges ops and reports words-level state

  The view (view/chart/main.ts, bundled by scripts/build-chart-view.mjs into
  one self-contained HTML document) streams candles straight from the
  exchanges in the user's browser. This server never sees bars or prices from
  a feed, and no tool result carries any: results describe the chart in words.
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
} from "./market.js";
import { chartStatus, createChart, hasChart, pushOps, syncChart, waitForAck, type ChartOp, type ViewState } from "./store.js";

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
 *     `<hash>.claudemcpcontent.com`;
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
]);

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
  })
  .describe("Words-level state of the view: no bars, no exchange prices.");

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

/** The view's own report, in words (its symbol is "venue:TICKER", its timeframe the short key). */
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
  if (view.error) text += ` The chart reported a problem: ${view.error}.`;
  return text;
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
      title: "Open a live Vela chart",
      description:
        "Shows an interactive live chart from Vela, our next-generation charting platform, inside the chat: crypto candles streamed from Hyperliquid or Binance in the user's browser, with optional native indicators, horizontal levels, shaded zones and a date range. Use it when the user wants to see or discuss a crypto market visually. Returns a chart_id; change the open chart afterwards with chart_command rather than opening a new one. The result describes the chart in words only: this tool never returns candles or prices, so do not quote live prices from it. Symbols: \"BTC\" or \"hyperliquid:BTC\" (Hyperliquid perpetuals), \"binance:BTCUSDT\" (Binance spot); a bare pair ending in USDT/USDC goes to Binance.",
      inputSchema: z.object({
        symbol: z.string().max(40).describe('e.g. "BTC", "hyperliquid:ETH", "binance:BTCUSDT".'),
        timeframe: z.enum(TIMEFRAME_KEYS).default("4h").describe("Candle timeframe."),
        indicators: z.array(z.enum(NATIVE_INDICATOR_KEYS)).max(5).optional().describe("Native indicators to add."),
        levels: z.array(levelSchema).max(20).optional().describe("Horizontal levels to draw."),
        zones: z.array(zoneSchema).max(10).optional().describe("Price zones to shade."),
        range: z.enum(RANGE_PRESETS).optional().describe("Visible date range, ending on the newest candle."),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: {
        ui: { resourceUri: CHART_RESOURCE_URI },
        // Older ChatGPT clients read the template from here.
        "openai/outputTemplate": CHART_RESOURCE_URI,
        "openai/toolInvocation/invoking": "Opening the chart",
        "openai/toolInvocation/invoked": "Chart opened",
      },
    },
    async ({ symbol, timeframe, indicators, levels, zones, range }) => {
      const market = parseMarket(symbol);
      if ("error" in market) return textError(`Cannot open the chart: ${market.error}.`);
      const badZone = zones?.find((z) => z.low >= z.high);
      if (badZone) return textError(`Cannot open the chart: a zone's low (${badZone.low}) must be below its high (${badZone.high}).`);
      const chartId = createChart();
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
      return { ...result, _meta: { ui: { resourceUri: CHART_RESOURCE_URI } } };
    },
  );

  server.registerTool(
    "chart_command",
    {
      title: "Change an open Vela chart",
      description:
        "Edits a chart already open in the chat (from chart_open) in place: switch market or timeframe, add or remove a native indicator, draw a level or a zone, clear drawings, or zoom to a date range. Ops apply in order. Waits up to about 5 seconds for the chart to confirm and returns what it now shows, in words (no prices from the feed). If the chart is not on screen the ops stay queued and apply when it is shown again. Use chart_open instead to show a new chart.",
      inputSchema: z.object({
        chart_id: z.string().max(40).describe("The chart_id chart_open returned."),
        ops: z.array(opSchema).min(1).max(20),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ chart_id, ops }) => {
      if (!hasChart(chart_id)) {
        return textError(`No open chart has the id "${chart_id}" (it may have expired). Call chart_open to show a new chart.`);
      }
      const normalized: ChartOp[] = [];
      for (const op of ops) {
        if (op.op === "set_market") {
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
      const seq = pushOps(chart_id, normalized);
      if (seq === null) return textError(`No open chart has the id "${chart_id}". Call chart_open to show a new chart.`);
      const started = Date.now();
      const applied = await waitForAck(chart_id, seq, 5_000);
      const status = chartStatus(chart_id);
      const view = status?.view;
      const text = applied
        ? `Done. ${view ? describeView(view) : ""}`.trim()
        : `Queued ${normalized.length} change${normalized.length === 1 ? "" : "s"}: the chart has not confirmed yet (it may be closed or off screen), so they apply when it is next shown.` +
          (view ? ` Last report: ${describeView(view)}` : "");
      return ok(text, { chart_id, applied, seq, waited_ms: Date.now() - started, view: view ?? null });
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
        chart_id: z.string().max(40),
        acked_seq: z.number().int().min(0),
        state: viewStateSchema.optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: {
        // No resourceUri: a host must not render a second view for the poll.
        ui: { visibility: ["app"] },
        // Older ChatGPT clients: callable from the widget, hidden from the model.
        "openai/widgetAccessible": true,
        "openai/visibility": "private",
      },
    },
    async ({ chart_id, acked_seq, state }) => {
      const synced = syncChart(chart_id, acked_seq, state);
      if (!synced) return ok("unknown chart", { known: false, ops: [] });
      return ok(`${synced.ops.length} pending`, { known: true, ops: synced.ops });
    },
  );
}

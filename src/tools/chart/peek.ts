/*
  A picture of the chart the signed-in member has open in Vela, for the AI
  assistant they connected ("show me my chart").

  The app does the work: this tool asks it (POST /api/agents/peek, the
  member's own token), the app passes the ask to the member's visible Vela
  tab, the tab captures its chart and the app hands the picture back, all
  within a few seconds. Nothing is kept on either side after the answer.

  The data rule is the app's, and this tool only relays it: a picture may
  leave LuxAlgo for an AI assistant only when every market on the chart comes
  from a crypto exchange's own feed. For anything else the app answers
  `not_allowed_for_market` and sends no picture. The result carries the
  picture as image content and describes it in words (market, timeframe,
  indicators, the dates on screen); it carries no prices of its own.

  Off unless the account tools are switched on (_shared/member.ts), and never
  on the Claude address. While the app's own switch for it is off, the route
  answers 404 and the tool says it is not available yet.
*/
import { z } from "zod";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { registerProtectedTool } from "../../auth/protected-tool.js";
import type { AuthRuntime } from "../../auth/runtime.js";
import { AppApiError, AppAuthError, AppPermissionError, appSend } from "../../platform/app-client.js";
import { errorMessage, textError } from "../_shared/result.js";
import { isMarketSource, marketFromKey, marketWords, type MemberMarket } from "../_shared/markets.js";
import { CHART_ORIGIN, symbolChartUrl, velaInstrumentId } from "../_shared/vela.js";
import { anyTimeframeWords } from "./market.js";

/** Vela's largest grid has 16 charts; the app takes 0 to 15. */
const MAX_CHART_INDEX = 15;

type PeekImage = { mime?: string; mimeType?: string; dataBase64: string; width?: number; height?: number };
type PeekChart = {
  symbol: string;
  timeframe?: string | null;
  provider: string;
  indicators?: string[];
  visibleRange?: { from: string; to: string } | null;
};
type PeekAnswer =
  | { status: "ok"; image: PeekImage; chart: PeekChart }
  | { status: "no_open_chart" }
  | { status: "not_allowed_for_market"; market?: string; reason?: string }
  | { status: "capture_failed" }
  | { status: "timeout" };

const OPEN_VELA = `${CHART_ORIGIN}/chart`;

const NO_OPEN_CHART = `No Vela chart of the member's is open and visible right now, or their Vela tab has not noticed the assistant yet (it checks about once a minute). Ask them to open Vela at ${OPEN_VELA}, keep that tab visible, and ask again in a minute.`;

/** The chart's market, as the data server names it: a `source:` prefix wins, else the provider that serves it. */
function chartMarket(chart: PeekChart): MemberMarket | null {
  const pinned = marketFromKey(chart.symbol);
  if (pinned) return pinned;
  const source = chart.provider.trim().toLowerCase();
  const symbol = chart.symbol.includes(":") ? chart.symbol.slice(chart.symbol.indexOf(":") + 1) : chart.symbol;
  return isMarketSource(source) && symbol ? { source, symbol } : null;
}

/** The same market and timeframe on Vela, when Vela can name the market. */
function chartUrl(market: MemberMarket | null, timeframe: string | null): string | undefined {
  const id = market && velaInstrumentId(market.source, market.symbol);
  if (!id) return undefined;
  return timeframe ? symbolChartUrl(id, timeframe) : symbolChartUrl(id, "").replace(/&tf=$/, "");
}

function okResult(image: PeekImage, chart: PeekChart): CallToolResult {
  const market = chartMarket(chart);
  const timeframe = chart.timeframe?.trim() || null;
  const url = chartUrl(market, timeframe);
  const indicators = (chart.indicators ?? []).filter(Boolean);
  const parts = [
    `The picture shows ${market ? marketWords(market) : chart.symbol}`,
    timeframe ? `, ${anyTimeframeWords(timeframe) ?? `timeframe ${timeframe}`}` : "",
    indicators.length ? `, with ${indicators.join(", ")}` : "",
    chart.visibleRange ? `, from ${chart.visibleRange.from.slice(0, 10)} to ${chart.visibleRange.to.slice(0, 10)}` : "",
    ".",
    url ? ` Open it in Vela: ${url}` : "",
  ];
  return {
    content: [
      { type: "image", data: image.dataBase64, mimeType: image.mime ?? image.mimeType ?? "image/png" },
      { type: "text", text: parts.join("") },
    ],
    structuredContent: {
      status: "ok",
      symbol: market ? `${market.source}:${market.symbol}` : chart.symbol,
      timeframe,
      indicators,
      ...(url ? { chart_url: url } : {}),
    },
  };
}

/** A plain answer with no picture: the status in structuredContent, the words for the member in text. */
function noPicture(status: string, text: string, extra: Record<string, unknown> = {}): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: { status, ...extra } };
}

function answer(data: PeekAnswer): CallToolResult {
  switch (data.status) {
    case "ok":
      return okResult(data.image, data.chart);
    case "no_open_chart":
      return noPicture("no_open_chart", NO_OPEN_CHART);
    case "not_allowed_for_market": {
      const market = data.market ? marketFromKey(data.market) : null;
      const named = market ? marketWords(market) : data.market;
      const why =
        data.reason === "script_reads_other_market"
          ? " An indicator on it draws data from another market that is not a crypto exchange feed."
          : "";
      return noPicture(
        "not_allowed_for_market",
        `The open chart${named ? `, ${named},` : ""} cannot be shared as a picture: only crypto charts fed by an exchange (Binance, Binance.US, Coinbase, Hyperliquid) can.${why} Describe what the member wants to know in words, or ask them to switch the chart to a crypto market.`,
        { ...(data.market ? { market: data.market } : {}), ...(data.reason ? { reason: data.reason } : {}) },
      );
    }
    case "capture_failed":
      return noPicture("capture_failed", "The Vela tab could not take a picture of the chart this time. Try again in a moment.");
    case "timeout":
      return noPicture("timeout", "The Vela tab did not answer in time. Try again in a moment, with the tab open and visible.");
    default:
      return textError("The LuxAlgo app gave an answer this server does not know. Try again in a moment.");
  }
}

/** Errors in words; sign-in and plan answers always go up to the auth wrapper (docs/auth.md §6). */
function failure(error: unknown): CallToolResult {
  if (error instanceof AppAuthError || error instanceof AppPermissionError) throw error;
  if (error instanceof AppApiError && error.status === 404) {
    return textError("Seeing the member's open Vela chart is not available yet.");
  }
  if (error instanceof AppApiError && error.status === 429) {
    return textError("Too many chart pictures asked for in the last minute. Wait a minute and try again.");
  }
  return textError(`Could not get a picture of the chart: ${errorMessage(error)}.`);
}

export function registerChartPeekTools(server: McpServer, runtime: AuthRuntime) {
  registerProtectedTool(
    server,
    runtime,
    "chart_peek",
    {
      title: "See my open Vela chart",
      description:
        "A picture of the chart the signed-in member has open right now in Vela, our next-generation charting platform, in their browser, as they see it, with the market, timeframe and indicators in words and a Vela link (chart_url). Use it when the member asks about the chart they have open in Vela (\"look at my chart\", \"what do you see here?\"). To show a market inside the chat instead, use chart_open. Works for crypto charts fed by an exchange only (Binance, Binance.US, Coinbase, Hyperliquid); for any other market it says so and sends no picture. The member's Vela tab must be open and visible; a first ask after a quiet spell can say no chart is open, and asking again a minute later works. The result carries no prices beyond what the picture shows. chart_index picks one chart of a multi-chart layout (0 is the first); without it, the chart the member is working on.",
      inputSchema: z.object({
        chart_index: z
          .number()
          .int()
          .min(0)
          .max(MAX_CHART_INDEX)
          .optional()
          .describe("One chart of a multi-chart layout, in layout order (0 is the first). Leave it out for the chart the member is working on."),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ chart_index }) => {
      try {
        const data = await appSend<PeekAnswer>("POST", "/api/agents/peek", {
          body: chart_index === undefined ? {} : { chartIndex: chart_index },
        });
        return answer(data);
      } catch (error) {
        return failure(error);
      }
    },
  );
}

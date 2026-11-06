/*
  Vela chart links ("Open in Vela") that tool results carry as `chart_url`, in the
  address forms the LuxAlgo app's chart reads (app: src/shared/chart-address.ts and
  the chart-link params in use-prompt-input.ts):

    ?pineScriptCodeId=<id>          a Library script loaded on the chart
    ?symbol=<source:TICKER>&tf=<tf>  a market on an interval; a source-qualified id
                                     (`binance:BTCUSDT`) names one exact market

  LUXALGO_CHART_ORIGIN points every link at a non-production Vela.
*/
import { currentSurface } from "../../auth/surface.js";

export const CHART_ORIGIN = process.env.LUXALGO_CHART_ORIGIN ?? "https://vela.luxalgo.com";

/**
 * Whether results on this address carry Vela chart links. Not on the Claude address:
 * its tool definitions and results are frozen, byte for byte, while Anthropic reviews
 * them (test/smoke/claude-surface.mjs holds the line). Read it at registration, which
 * hosted entries run inside the request's surface.
 */
export const velaLinksHere = (): boolean => currentSurface().kind !== "claude";

/** A Library script opened on a Vela chart. */
export const indicatorChartUrl = (pineScriptCodeId: string): string =>
  `${CHART_ORIGIN}/chart?pineScriptCodeId=${encodeURIComponent(pineScriptCodeId)}`;

/**
 * The Vela data sources a source-qualified instrument id may name (the app's
 * INSTRUMENT_ID_RE). Anything else gets no link rather than a guessed market.
 */
const VELA_SOURCES = new Set(["binance", "binance.us", "coinbase", "hyperliquid", "edgx", "fx", "commodities", "cme"]);

/** `binance` + `BTCUSDT` → `binance:BTCUSDT`; null when Vela has no such source. */
export function velaInstrumentId(source: string, ticker: string): string | null {
  const key = source.trim().toLowerCase();
  const symbol = ticker.trim();
  return VELA_SOURCES.has(key) && symbol ? `${key}:${symbol}` : null;
}

/**
 * One exact market on a Vela chart at an interval (`15`, `1h`, `D`). The colon of the
 * instrument id stays readable; everything else is encoded.
 */
export const symbolChartUrl = (instrumentId: string, tf: string): string =>
  `${CHART_ORIGIN}/chart?symbol=${encodeURIComponent(instrumentId).replace(/%3A/g, ":")}&tf=${encodeURIComponent(tf)}`;

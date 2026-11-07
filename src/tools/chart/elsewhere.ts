/*
  Markets the chat chart can't show here. The chart streams crypto markets
  from exchanges (Hyperliquid, Binance) in the user's browser; a stock, a
  future or a forex pair has no candles there. When the model asks for one,
  chart_open and chart_command answer in words with the market's Vela link
  instead of opening an empty chart. Server only (it reads Hyperliquid's
  listing and LUXALGO_CHART_ORIGIN), so the view never bundles it.
*/
import { CHART_ORIGIN } from "../_shared/vela.js";
import { marketChartUrl, marketWords as memberMarketWords, parseMarketInput, type MemberMarket } from "../_shared/markets.js";
import { HIP3_FORM, parseMarket, velaSymbolUrl, velaTimeframe, type Market, type Timeframe } from "./market.js";
import { hyperliquidListing } from "./hyperliquid-listing.js";

/** A market the chart can open, or why not in words, with the Vela link for it when there is one. */
export type ChartMarket = { market: Market } | { error: string; chart_url?: string; hip3_symbols?: string[] };

/** What this chart is, in one sentence every refusal shares. */
const WHAT_IT_SHOWS = "This chat chart shows crypto markets from exchanges (Hyperliquid, Binance).";

/** The Vela link for what the model typed, on the chart's timeframe. */
function typedVelaUrl(typed: string, tf: Timeframe): string {
  const url = velaSymbolUrl(typed, CHART_ORIGIN);
  return url.includes("?") ? `${url}&tf=${encodeURIComponent(velaTimeframe(tf))}` : url;
}

function elsewhere(subject: string, url: string, extra = ""): ChartMarket {
  return {
    error: `${WHAT_IT_SHOWS} ${subject} is not one of them, so the chart did not open.${extra} Stocks, futures and forex are on Vela; give the user this link to open it there: ${url}`,
    chart_url: url,
  };
}

/** Members' market names (edgx:AAPL, fx:EURUSD, cme:ES1!, NASDAQ:AAPL, coinbase:BTC-USD) that this chart has no feed for. */
function memberMarket(typed: string): MemberMarket | null {
  if (!typed.includes(":") && !typed.includes("!")) return null;
  const parsed = parseMarketInput(typed);
  if ("error" in parsed || parsed.source === "hyperliquid" || parsed.source === "binance") return null;
  return parsed;
}

/**
 * The market for a symbol the model typed. `hip3`: whether the chart view can
 * chart Hyperliquid HIP-3 perpetuals (built with Vela 0.10.2 or later).
 */
export async function chartMarket(typed: string, tf: Timeframe, { hip3 }: { hip3: boolean }): Promise<ChartMarket> {
  const parsed = parseMarket(typed, { hip3 });
  if ("error" in parsed) {
    const member = memberMarket(typed.trim());
    if (member) return elsewhere(memberMarketWords(member), marketChartUrl(member, tf) ?? typedVelaUrl(typed, tf));
    return { error: parsed.error };
  }
  // Binance pairs and Hyperliquid spot pairs are crypto by their shape; Hyperliquid's perpetuals are checked against its listing.
  if (parsed.venue !== "hyperliquid" || parsed.ticker.includes("/")) return { market: parsed };
  const listing = await hyperliquidListing();
  if (!listing) return { market: parsed };

  if (parsed.hip3) {
    if (!listing.hip3Known || listing.hip3.has(parsed.ticker.toUpperCase())) return { market: parsed };
    const others = listing.hip3ByCoin.get(parsed.hip3.coin) ?? [];
    return {
      error:
        `Hyperliquid's ${parsed.hip3.dex} dex lists no live ${parsed.hip3.coin} perpetual, so the chart did not open.` +
        (others.length ? ` It trades as ${others.map((name) => `hyperliquid:${name}`).join(", ")}: call chart_open with one of those.` : ""),
      ...(others.length ? { hip3_symbols: others.map((name) => `hyperliquid:${name}`) } : {}),
    };
  }

  if (listing.perps.has(parsed.ticker.toUpperCase())) return { market: parsed };
  // A coin Hyperliquid lists only on HIP-3 dexes: the model writes the dex out (Vela never picks one for a bare ticker).
  const hip3Names = hip3 ? (listing.hip3ByCoin.get(parsed.ticker.toUpperCase()) ?? []).map((name) => `hyperliquid:${name}`) : [];
  const typedTicker = typed.trim().replace(/^hyperliquid:/i, "");
  const url = typedVelaUrl(typedTicker, tf);
  if (!hip3Names.length) return elsewhere(`"${typedTicker}"`, url);
  return {
    error:
      `${WHAT_IT_SHOWS} Hyperliquid lists no "${typedTicker}" on its main dex, so the chart did not open. ` +
      `It trades on Hyperliquid as a HIP-3 perpetual: ${hip3Names.join(", ")} (${HIP3_FORM}); to chart one here, call chart_open with that symbol. ` +
      `Stocks, futures and forex are on Vela: ${url}`,
    chart_url: url,
    hip3_symbols: hip3Names,
  };
}

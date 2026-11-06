/*
  Market vocabulary shared by the chart tools: turning what a model types
  ("BTC", "hyperliquid:BTC", "binance:ETHUSDT", "4h") into the venue-pinned
  symbol and timeframe Vela's providers take, and back into words.

  Only the two keyless crypto venues the chart view bundles are known here
  (Hyperliquid and Binance). A bare coin ("BTC") goes to Hyperliquid, a bare
  pair with a stablecoin quote ("BTCUSDT") to Binance.
*/

export type Venue = "hyperliquid" | "binance";

export type Market = {
  venue: Venue;
  /** The provider's own ticker: "BTC" on Hyperliquid, "BTCUSDT" on Binance. */
  ticker: string;
  /** What Vela's setMarket takes: "hyperliquid:BTC". */
  symbol: string;
};

const VENUE_NAMES: Record<Venue, string> = { hyperliquid: "Hyperliquid", binance: "Binance" };
const STABLE_QUOTES = ["USDT", "USDC", "FDUSD", "BUSD"];

export function parseMarket(input: string): Market | { error: string } {
  const raw = input.trim();
  if (!raw) return { error: "symbol is empty" };
  const colon = raw.indexOf(":");
  let venue: Venue;
  let ticker: string;
  if (colon >= 0) {
    const prefix = raw.slice(0, colon).toLowerCase();
    if (prefix !== "hyperliquid" && prefix !== "binance") {
      return { error: `unknown venue "${raw.slice(0, colon)}": use hyperliquid: or binance:` };
    }
    venue = prefix;
    ticker = raw.slice(colon + 1).trim();
  } else {
    ticker = raw;
    const upper = raw.toUpperCase();
    venue = STABLE_QUOTES.some((quote) => upper.endsWith(quote) && upper.length > quote.length) ? "binance" : "hyperliquid";
  }
  // Hyperliquid tickers are case-sensitive for a few spot names ("PURR/USDC"), but perps are upper-case.
  ticker = venue === "binance" ? ticker.toUpperCase() : ticker.includes("/") ? ticker : ticker.toUpperCase();
  if (!/^[A-Za-z0-9./_-]{1,30}$/.test(ticker)) return { error: `"${ticker}" is not a valid ticker` };
  return { venue, ticker, symbol: `${venue}:${ticker}` };
}

export function marketWords(market: Market): string {
  return `${market.ticker} on ${VENUE_NAMES[market.venue]}`;
}

/** Timeframes the view offers, keyed by the short form models and Vela URLs use. */
const TIMEFRAMES = {
  "1m": { vela: "1", words: "1 minute" },
  "5m": { vela: "5", words: "5 minute" },
  "15m": { vela: "15", words: "15 minute" },
  "30m": { vela: "30", words: "30 minute" },
  "1h": { vela: "60", words: "1 hour" },
  "2h": { vela: "120", words: "2 hour" },
  "4h": { vela: "240", words: "4 hour" },
  "12h": { vela: "720", words: "12 hour" },
  "1d": { vela: "D", words: "daily" },
  "1w": { vela: "W", words: "weekly" },
} as const;

export type Timeframe = keyof typeof TIMEFRAMES;
export const TIMEFRAME_KEYS = Object.keys(TIMEFRAMES) as [Timeframe, ...Timeframe[]];

export function timeframeWords(tf: Timeframe): string {
  return `${TIMEFRAMES[tf].words} candles`;
}

export function velaTimeframe(tf: Timeframe): string {
  return TIMEFRAMES[tf].vela;
}

/** Native (core-computed) indicators the view may add; names are Vela's registered types. */
export const NATIVE_INDICATORS = {
  rsi: "RSI",
  macd: "MACD",
  "moving-average": "Moving average",
  "bollinger-bands": "Bollinger Bands",
  "average-true-range": "ATR",
  stochastic: "Stochastic",
  vwap: "VWAP",
  vpvr: "Visible range volume profile",
} as const;
export type NativeIndicator = keyof typeof NATIVE_INDICATORS;
export const NATIVE_INDICATOR_KEYS = Object.keys(NATIVE_INDICATORS) as [NativeIndicator, ...NativeIndicator[]];

export const RANGE_PRESETS = ["1D", "1W", "1M", "3M", "6M", "1Y", "YTD", "ALL"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

const RANGE_WORDS: Record<RangePreset, string> = {
  "1D": "the last day",
  "1W": "the last week",
  "1M": "the last month",
  "3M": "the last 3 months",
  "6M": "the last 6 months",
  "1Y": "the last year",
  YTD: "the year to date",
  ALL: "all loaded history",
};

export function rangeWords(range: RangePreset): string {
  return RANGE_WORDS[range];
}

/** The same chart on Vela itself. */
export function velaChartUrl(market: Market, tf: Timeframe): string {
  return `https://vela.luxalgo.com/chart?symbol=${encodeURIComponent(market.symbol)}&tf=${tf}`;
}

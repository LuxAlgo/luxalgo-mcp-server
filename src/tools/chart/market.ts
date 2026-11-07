/*
  Market vocabulary shared by the chart tools: turning what a model types
  ("BTC", "hyperliquid:BTC", "binance:ETHUSDT", "4h") into the venue-pinned
  symbol and timeframe Vela's providers take, and back into words.

  Only the two keyless crypto venues the chart view bundles are known here
  (Hyperliquid and Binance). A bare coin ("BTC") goes to Hyperliquid, a bare
  pair with a stablecoin quote ("BTCUSDT") to Binance.

  Hyperliquid also lists the perpetuals of builder-deployed (HIP-3) dexes,
  named by the dex, a colon and the coin: `hyperliquid:xyz:TSLA` (Vela 0.10.2
  and later; the first colon names the provider, the rest is the provider's
  own ticker `xyz:TSLA`). They are Hyperliquid exchange data like any other
  Hyperliquid market. A bare "TSLA" is never read as one: Vela's provider
  resolves a bare ticker to the main dex only, and several dexes may list the
  same coin, so the dex is always written out.

  Whether the model may read numbers off a chart (last price, change, the
  visible high and low, indicator values) is decided here and nowhere else,
  from where the provider's candles come from: numbersAllowedFor().
*/

export type Venue = "hyperliquid" | "binance";

/**
 * Where a provider's candles come from:
 *   exchange   the exchange's own public feed, streamed in the user's browser
 *              (crypto venues such as Hyperliquid and Binance);
 *   licensed   anything else: a data vendor, futures or stock exchanges whose
 *              data is licensed.
 * Only "exchange" charts may hand numbers to the model; "licensed" charts are
 * described in words only. A provider missing from this table counts as
 * licensed, so adding one never opens numbers by accident.
 */
export type DataSource = "exchange" | "licensed";

const PROVIDER_SOURCES: Record<Venue, DataSource> = { hyperliquid: "exchange", binance: "exchange" };

/** The one place that decides whether the model may receive numbers for a provider's charts. */
export function numbersAllowedFor(provider: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROVIDER_SOURCES, provider) && PROVIDER_SOURCES[provider as Venue] === "exchange";
}

export type Market = {
  venue: Venue;
  /** The provider's own ticker: "BTC" on Hyperliquid, "BTCUSDT" on Binance, "xyz:TSLA" for a HIP-3 perpetual. */
  ticker: string;
  /** A Hyperliquid HIP-3 perpetual's dex ("xyz") and coin ("TSLA"); absent for every other market. */
  hip3?: { dex: string; coin: string };
  /** What Vela's setMarket takes: "hyperliquid:BTC". */
  symbol: string;
  /** Whether the model may receive numbers for this market (numbersAllowedFor its provider). */
  numbersAllowed: boolean;
};

const VENUE_NAMES: Record<Venue, string> = { hyperliquid: "Hyperliquid", binance: "Binance" };
const STABLE_QUOTES = ["USDT", "USDC", "FDUSD", "BUSD"];

/** The oldest @luxalgo/vela whose Hyperliquid provider serves HIP-3 perpetuals. */
export const HIP3_MIN_VELA = "0.10.2";

/** Whether a Vela version (the one the chart view was built with) serves HIP-3 perpetuals. */
export function velaServesHip3(version: string | undefined): boolean {
  const parts = (v: string) => v.split("-")[0].split(".").map((n) => Number(n) || 0);
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) return false;
  const [a, b] = [parts(version), parts(HIP3_MIN_VELA)];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

/** A HIP-3 dex name and coin as Hyperliquid spells them (lower-case dex, like the provider's parseCoin). */
const HIP3_DEX = /^[a-z0-9]{1,16}$/;
const HIP3_COIN = /^[A-Za-z0-9._-]{1,24}$/;

export const HIP3_FORM = "hyperliquid:<dex>:<COIN>, e.g. hyperliquid:xyz:TSLA";

/**
 * A symbol as the chart takes it. `hip3: false` refuses the HIP-3 form (the
 * server does, while the chart view is built with a Vela that cannot chart it).
 */
export function parseMarket(input: string, { hip3 = true }: { hip3?: boolean } = {}): Market | { error: string } {
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
  if (venue === "hyperliquid" && ticker.includes(":")) {
    const [dexWritten, coinWritten, ...rest] = ticker.split(":");
    const dex = dexWritten.trim().toLowerCase();
    const coin = (coinWritten ?? "").trim().toUpperCase();
    if (rest.length || !HIP3_DEX.test(dex) || !HIP3_COIN.test(coin)) {
      return { error: `"${ticker}" is not a Hyperliquid HIP-3 market: write it as ${HIP3_FORM}` };
    }
    if (!hip3) return { error: `Hyperliquid HIP-3 markets such as "hyperliquid:${dex}:${coin}" are not on this chart yet` };
    const hip3Ticker = `${dex}:${coin}`;
    return { venue, ticker: hip3Ticker, symbol: `hyperliquid:${hip3Ticker}`, numbersAllowed: numbersAllowedFor(venue), hip3: { dex, coin } };
  }
  // Hyperliquid tickers are case-sensitive for a few spot names ("PURR/USDC"), but perps are upper-case.
  ticker = venue === "binance" ? ticker.toUpperCase() : ticker.includes("/") ? ticker : ticker.toUpperCase();
  if (!/^[A-Za-z0-9./_-]{1,30}$/.test(ticker)) return { error: `"${ticker}" is not a valid ticker` };
  return { venue, ticker, symbol: `${venue}:${ticker}`, numbersAllowed: numbersAllowedFor(venue) };
}

/** "BTC on Hyperliquid", "BTCUSDT on Binance", "TSLA perpetual on Hyperliquid (xyz)". */
export function marketWords(market: Market): string {
  if (market.hip3) return `${market.hip3.coin} perpetual on ${VENUE_NAMES[market.venue]} (${market.hip3.dex})`;
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

/** Words for a timeframe as Vela names it ("60", "D") or by its short key ("1h"); null for one not listed here. */
export function anyTimeframeWords(tf: string): string | null {
  const entry = Object.entries(TIMEFRAMES).find(([key, value]) => key === tf || value.vela === tf);
  return entry ? `${entry[1].words} candles` : null;
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

/** Vela's production origin; the server passes LUXALGO_CHART_ORIGIN when set, the view the origin of chart_open's chart_url. */
export const DEFAULT_CHART_ORIGIN = "https://vela.luxalgo.com";

/** The same chart on Vela itself. */
export function velaChartUrl(market: Market, tf: Timeframe, origin: string = DEFAULT_CHART_ORIGIN): string {
  return `${origin}/chart?symbol=${encodeURIComponent(market.symbol)}&tf=${tf}`;
}

/**
 * Vela's chart seeded with what someone typed (`?symbol=AAPL`): Vela's chart
 * reads a bare ticker or a `source:TICKER` id there. Anything that is not
 * ticker-shaped opens the chart without a symbol.
 */
export function velaSymbolUrl(typed: string, origin: string = DEFAULT_CHART_ORIGIN): string {
  const symbol = typed.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9.!:/_-]{0,39}$/.test(symbol) ? `${origin}/chart?symbol=${encodeURIComponent(symbol)}` : `${origin}/chart`;
}

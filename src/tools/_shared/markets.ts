/*
  Markets as the member-account tools name them: what a model types
  ("binance:BTCUSDT", "hyperliquid:BTC", "edgx:AAPL", "NASDAQ:AAPL",
  "BTCUSDT", "ES1!") turned into the LuxAlgo data server's market identity
  `{ source, symbol }`, which is what an alert watches and what a watchlist
  row streams, and back into words and a Vela chart link.

  The sources are the data server's (the same eight a Vela chart link may
  name, _shared/vela.ts). A symbol keeps the case it is written in when it
  mixes cases (Hyperliquid's `kPEPE`), and one written all in lower case is
  upper-cased, as the app does. A bare ticker is read only when it cannot
  mean two things: a pair quoted in a stablecoin is a Binance pair, a ticker
  with "!" a CME continuous contract. Anything else must name its source, so
  a stock is never watched on a crypto venue by guess.

  Watchlist rows (the app's `{ symbol, category, section?, venue?, flag? }`)
  carry a canonical symbol and a category, plus `venue` when the category's
  default feed would stream another market (a Binance pair, a perpetual,
  Hyperliquid). rowMarket and marketRow translate both ways; the app keeps
  one identity per market on save (it drops a venue its default feed already
  reaches).
*/
import { velaTimeframe, type Timeframe } from "../chart/market.js";
import { symbolChartUrl, velaInstrumentId } from "./vela.js";

export const MARKET_SOURCES = ["binance", "binance.us", "coinbase", "hyperliquid", "edgx", "fx", "commodities", "cme"] as const;
export type MarketSource = (typeof MARKET_SOURCES)[number];

export type MemberMarket = { source: MarketSource; symbol: string };

const CRYPTO_SOURCES: ReadonlySet<MarketSource> = new Set<MarketSource>(["binance", "binance.us", "coinbase", "hyperliquid"]);
const SOURCE_NAMES: Record<MarketSource, string> = {
  binance: "Binance",
  "binance.us": "Binance.US",
  coinbase: "Coinbase",
  hyperliquid: "Hyperliquid",
  edgx: "US stocks",
  fx: "forex",
  commodities: "commodities",
  cme: "CME futures",
};
/** US listing exchanges a stock may be prefixed with; every one streams from edgx. */
const US_LISTINGS = new Set(["nasdaq", "nyse", "amex", "arca", "bats"]);
const STABLE_PAIR = /^[A-Z0-9]{2,20}(USDT|USDC|FDUSD|BUSD|TUSD)$/;
/** The data server's ticker shape: never "..", never a leading "." or "/". */
const TICKER = /^(?!.*\.\.)[A-Za-z0-9!_-][A-Za-z0-9.!/_-]{0,39}$/;

export const isMarketSource = (value: string): value is MarketSource => (MARKET_SOURCES as readonly string[]).includes(value);
export const isCryptoSource = (source: MarketSource): boolean => CRYPTO_SOURCES.has(source);

/** The spelling a market is stored with: mixed case kept on Hyperliquid, upper case everywhere else. */
function spelling(source: MarketSource, written: string): string {
  if (source === "hyperliquid") return written === written.toLowerCase() ? written.toUpperCase() : written;
  return written.toUpperCase();
}

export const MARKET_INPUT_HELP =
  'a market as source:TICKER, e.g. "binance:BTCUSDT", "hyperliquid:BTC", "coinbase:BTC-USD", "edgx:AAPL" (US stocks and ETFs; "NASDAQ:AAPL" works too), "fx:EURUSD", "commodities:XAUUSD", "cme:ES1!". A bare stablecoin pair ("BTCUSDT") is read as Binance and a bare "ES1!" as CME.';

/** A typed market, or why it is not one. */
export function parseMarketInput(raw: string): MemberMarket | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: "the market is empty" };
  const colon = trimmed.indexOf(":");
  let source: MarketSource;
  let written: string;
  if (colon >= 0) {
    const prefix = trimmed.slice(0, colon).trim().toLowerCase();
    written = trimmed.slice(colon + 1).trim();
    if (isMarketSource(prefix)) source = prefix;
    else if (US_LISTINGS.has(prefix)) source = "edgx";
    else return { error: `"${trimmed.slice(0, colon)}" is not a market source: name ${MARKET_INPUT_HELP}` };
  } else {
    written = trimmed;
    const upper = trimmed.toUpperCase();
    if (upper.includes("!")) source = "cme";
    else if (STABLE_PAIR.test(upper)) source = "binance";
    else return { error: `"${trimmed}" needs its source: name ${MARKET_INPUT_HELP}` };
  }
  const symbol = spelling(source, written);
  if (!TICKER.test(symbol) || symbol.includes(":") || symbol.includes("|")) {
    return { error: `"${written}" is not a ticker the data server knows the shape of` };
  }
  return { source, symbol };
}

/** `binance` + `BTCUSDT` → `binance:BTCUSDT`, case kept. */
export const marketId = (market: MemberMarket): string => `${market.source}:${market.symbol}`;

/** One market identity for comparing: source plus upper-cased symbol (Hyperliquid's case-sensitive names compare equal only when spelled alike). */
export const marketKey = (market: MemberMarket): string =>
  `${market.source}:${market.source === "hyperliquid" ? market.symbol : market.symbol.toUpperCase()}`;

/** The data server's `source:SYMBOL` (an alert event's `market`) as a market; null for a source this server does not know. */
export function marketFromKey(key: string): MemberMarket | null {
  const colon = key.indexOf(":");
  if (colon < 0) return null;
  const source = key.slice(0, colon).toLowerCase();
  const symbol = key.slice(colon + 1).split(":")[0] ?? "";
  return isMarketSource(source) && symbol ? { source, symbol } : null;
}

/** "BTCUSDT on Binance", "AAPL (US stocks)". */
export function marketWords(market: MemberMarket): string {
  return isCryptoSource(market.source)
    ? `${market.symbol} on ${SOURCE_NAMES[market.source]}`
    : `${market.symbol} (${SOURCE_NAMES[market.source]})`;
}

/** The market on a Vela chart at a timeframe. */
export function marketChartUrl(market: MemberMarket, tf: Timeframe = "1d"): string | undefined {
  const id = velaInstrumentId(market.source, market.symbol);
  return id ? symbolChartUrl(id, velaTimeframe(tf)) : undefined;
}

// ── watchlist rows ─────────────────────────────────────────────────────────

export const WATCHLIST_CATEGORIES = ["Crypto", "Forex", "Commodities", "Stocks", "ETFs"] as const;
export type WatchlistCategory = (typeof WATCHLIST_CATEGORIES)[number];

export type WatchlistRow = {
  symbol: string;
  category: WatchlistCategory;
  section?: string;
  venue?: { source: string; ticker: string };
  flag?: string;
};

const SPOT_METALS = new Set(["XAUUSD", "XAGUSD"]);
const ROW_SYMBOL = /^[A-Za-z0-9.!-]{1,32}$/;

/** The market a row without a venue streams from: the category's default feed. */
function defaultFeed(row: Pick<WatchlistRow, "symbol" | "category">): MemberMarket {
  const symbol = row.symbol.toUpperCase();
  if (symbol.includes("!")) return { source: "cme", symbol };
  if (SPOT_METALS.has(symbol)) return { source: "commodities", symbol };
  switch (row.category) {
    case "Crypto": {
      // Coinbase's USD book: BTCUSD → BTC-USD.
      if (symbol.includes("-")) return { source: "coinbase", symbol };
      const quote = ["USDT", "USDC", "USD"].find((q) => symbol.endsWith(q) && symbol.length > q.length);
      return { source: "coinbase", symbol: quote ? `${symbol.slice(0, -quote.length)}-${quote}` : symbol };
    }
    case "Stocks":
    case "ETFs":
      return { source: "edgx", symbol };
    case "Forex":
      return { source: "fx", symbol };
    case "Commodities":
      return { source: "commodities", symbol };
  }
}

/** The market a stored row streams from and opens on the chart. */
export function rowMarket(row: WatchlistRow): MemberMarket {
  if (row.venue && isMarketSource(row.venue.source)) return { source: row.venue.source, symbol: row.venue.ticker };
  return defaultFeed(row);
}

/** How the apps file a market: crypto venues under Crypto, edgx under Stocks (or ETFs), fx under Forex, the rest under Commodities. */
function categoryFor(source: MarketSource, etf: boolean): WatchlistCategory {
  if (isCryptoSource(source)) return "Crypto";
  if (source === "edgx") return etf ? "ETFs" : "Stocks";
  if (source === "fx") return "Forex";
  return "Commodities";
}

/**
 * The canonical row symbol for a market, as the Vela apps store it: "/" dropped,
 * a Coinbase dash pair joined, a USDT/USDC quote folded into USD (BTCUSDT → BTCUSD,
 * BTC-USD → BTCUSD); a Hyperliquid perpetual keeps its coin ("BTC").
 */
function rowSymbol(ticker: string): string {
  let flat = ticker.replaceAll("/", "");
  if (flat.includes("-")) {
    const parts = flat.split("-");
    if (parts.length === 2 && parts[0] && ["USD", "USDC", "USDT"].includes(parts[1] ?? "")) flat = `${parts[0]}${parts[1]}`;
  }
  for (const stable of ["USDT", "USDC"]) {
    if (flat.endsWith(stable) && flat.length > stable.length) {
      flat = `${flat.slice(0, -stable.length)}USD`;
      break;
    }
  }
  return flat.toUpperCase();
}

/** The row to store for a market (`etf` files a US listing under ETFs), or why there is none. */
export function marketRow(market: MemberMarket, options: { etf?: boolean; section?: string } = {}): WatchlistRow | { error: string } {
  const symbol = rowSymbol(market.symbol);
  if (!ROW_SYMBOL.test(symbol)) return { error: `${marketWords(market)} has no symbol a watchlist can store` };
  const row: WatchlistRow = { symbol, category: categoryFor(market.source, options.etf === true) };
  if (options.section) row.section = options.section;
  // Pin the venue whenever the category's default feed would stream another market.
  const feed = defaultFeed(row);
  if (marketKey(feed) !== marketKey(market)) row.venue = { source: market.source, ticker: market.symbol };
  return row;
}

/** Words for a row: its market, its section when it has one. */
export function rowWords(row: WatchlistRow): string {
  return `${marketWords(rowMarket(row))}${row.section ? ` [${row.section}]` : ""}`;
}

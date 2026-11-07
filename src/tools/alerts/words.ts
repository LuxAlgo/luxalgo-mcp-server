/*
  Alerts in plain words: levels as the canonical decimals the alert rules
  store, timeframes as minutes and back, and a sentence for a rule, its
  frequency, its state, the plan usage the app reports and the history
  preview. Prices appear only as the member's own levels, or for a market fed
  by an exchange's public feed (chart/market.ts numbersAllowedFor, the one
  place that decides).
*/
import { numbersAllowedFor, type Timeframe } from "../chart/market.js";
import { marketFromKey, marketWords, isMarketSource, type MemberMarket } from "../_shared/markets.js";
import type { AlertFrequency, AlertScope, AlertUsage, AlertView, DraftPreview } from "./api.js";

// ── levels ─────────────────────────────────────────────────────────────────

const LEVEL_INPUT = /^(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,4}))?$/;

/**
 * A positive price as the canonical decimal string alert rules store: no
 * exponent, commas, "+", leading zeros or trailing fractional zeros
 * ("100,000.50" → "100000.5", 1e-7 → "0.0000001"). Null for anything that is
 * not a positive number of at most 64 characters.
 */
export function canonicalLevel(input: number | string): string | null {
  let text: string;
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input <= 0) return null;
    text = String(input);
  } else {
    text = input.trim().replace(/^\+/, "");
  }
  if (text.length === 0 || text.length > 100) return null;
  const match = LEVEL_INPUT.exec(text);
  if (!match) return null;
  let integer = (match[1] ?? "").replaceAll(",", "");
  let fraction = match[2] ?? "";
  if (!integer && !fraction) return null;
  const exponent = Number(match[3] ?? "0");
  // Shift the decimal point by the exponent.
  if (exponent > 0) {
    const moved = fraction.padEnd(exponent, "0");
    integer += moved.slice(0, exponent);
    fraction = moved.slice(exponent);
  } else if (exponent < 0) {
    const padded = integer.padStart(-exponent + 1, "0");
    fraction = padded.slice(padded.length + exponent) + fraction;
    integer = padded.slice(0, padded.length + exponent);
  }
  integer = integer.replace(/^0+/, "") || "0";
  fraction = fraction.replace(/0+$/, "");
  const canonical = fraction ? `${integer}.${fraction}` : integer;
  if (canonical === "0" || canonical.length > 64) return null;
  return canonical;
}

// ── timeframes ─────────────────────────────────────────────────────────────

export const TF_MINUTES: Record<Timeframe, number> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "1d": 1440,
  "1w": 10_080,
};

/** 60 → "1h", 15 → "15m", 1440 → "1D", 10080 → "1W". */
export function tfLabel(minutes: number): string {
  if (minutes % 10_080 === 0) return `${minutes / 10_080}W`;
  if (minutes % 1440 === 0) return `${minutes / 1440}D`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** The chart timeframe closest to `minutes` at or below it (for a chart link). */
export function chartTimeframe(minutes: number | undefined): Timeframe {
  if (!minutes) return "1h";
  let best: Timeframe = "1m";
  for (const [key, value] of Object.entries(TF_MINUTES) as Array<[Timeframe, number]>) {
    if (value <= minutes) best = key;
  }
  return best;
}

// ── rules ──────────────────────────────────────────────────────────────────

/** The market an alert watches, when it watches one this server knows. */
export function scopeMarket(scope: AlertScope): MemberMarket | null {
  const ref = scope.kind === "market" ? scope.market : scope.kind === "list" ? scope.markets[0] : undefined;
  if (!ref) return null;
  const source = ref.source.toLowerCase();
  return isMarketSource(source) ? { source, symbol: ref.symbol } : null;
}

export function scopeWords(scope: AlertScope): string {
  switch (scope.kind) {
    case "market": {
      const market = scopeMarket(scope);
      return market ? marketWords(market) : `${scope.market.symbol} (${scope.market.source})`;
    }
    case "list":
      return `${scope.markets.length} markets`;
    case "watchlist":
      return "the markets of a watchlist";
    case "universe":
      return `markets on ${scope.source}`;
  }
}

const LEVEL_WORDS: Record<string, string> = {
  cross: "crosses",
  cross_up: "crosses above",
  cross_down: "crosses below",
  above: "is above",
  below: "is below",
};
const CHANNEL_WORDS: Record<string, string> = {
  enter_channel: "enters the range",
  exit_channel: "leaves the range",
  inside_channel: "is inside the range",
  outside_channel: "is outside the range",
};

/** What the alert waits for, in words ("crosses above 100000"). */
export function conditionWords(view: AlertView): string {
  const { rule } = view;
  if (rule.type === "agent") return "meets its Custom Alert condition";
  const c = rule.condition as Record<string, unknown>;
  const kind = String(c.kind ?? "");
  if (LEVEL_WORDS[kind]) return `${LEVEL_WORDS[kind]} ${String(c.level)}`;
  if (CHANNEL_WORDS[kind]) return `${CHANNEL_WORDS[kind]} ${String(c.lower)} to ${String(c.upper)}`;
  if (kind === "move_up" || kind === "move_down") {
    const amount = c.unit === "percent" ? `${String(c.amount)}%` : String(c.amount);
    return `${kind === "move_up" ? "rises" : "falls"} ${amount} within ${String(c.bars)} bars of ${tfLabel(Number(c.tf))}`;
  }
  if (kind === "drawing") return "touches a drawing on the chart";
  return "meets its condition";
}

export function frequencyWords(frequency: AlertFrequency): string {
  switch (frequency.kind) {
    case "once":
      return "fires once, then stops";
    case "once_per_bar":
      return `fires at most once per ${tfLabel(frequency.tf)} bar`;
    case "once_per_bar_close":
      return `fires once per ${tfLabel(frequency.tf)} bar, when the bar closes`;
    case "once_per_minute":
      return "fires at most once a minute";
    case "every_time": {
      const seconds = Math.round(frequency.minIntervalMs / 1000);
      return `fires every time, at most once every ${seconds} second${seconds === 1 ? "" : "s"}`;
    }
  }
}

export function stateWords(view: AlertView): string {
  const reason = view.statusReason ? ` (${view.statusReason})` : "";
  switch (view.rule.status) {
    case "active":
      if (view.liveState === "arming") return "on, starting up";
      if (view.liveState === "unconfirmed") return "on, not yet confirmed running";
      if (view.liveState === "error") return `on, but could not start${reason}`;
      return "on";
    case "paused":
      return "paused";
    case "triggered":
      return "fired and stopped";
    case "expired":
      return "expired";
    case "suspended_plan":
      return `held back by the plan${reason}`;
    case "error":
      return `in error${reason}`;
  }
}

export const typeWords = (type: "price" | "agent"): string => (type === "price" ? "Price Alert" : "Custom Alert");

/** "3 Price Alerts on of the 10 the plan allows" / "…, no limit on this plan". */
export function usageWords(usage: AlertUsage): string {
  const one = (active: number, limit: number | null, name: string) =>
    `${active} ${name}${active === 1 ? "" : "s"} on${limit === null ? " (no limit on this plan)" : ` of the ${limit} the plan allows`}`;
  return `${one(usage.price.active, usage.price.limit, "Price Alert")}; ${one(usage.agent.active, usage.agent.limit, "Custom Alert")}.`;
}

/** The plain sentence for a history preview. */
export function previewWords(preview: DraftPreview, tfMinutes: number): string {
  if (preview.status === "unavailable") return `No history preview: ${preview.reason}`;
  const perDay = preview.perDay >= 10 ? Math.round(preview.perDay) : Math.round(preview.perDay * 10) / 10;
  const times = `${preview.count} time${preview.count === 1 ? "" : "s"}`;
  let text = `Over the last ${preview.days} day${preview.days === 1 ? "" : "s"} of ${tfLabel(tfMinutes)} bars it would have fired ${times}, about ${perDay} per day.`;
  if (preview.noisy) text += " That is often: once per bar close, a longer timeframe or a stricter condition fires less.";
  return text;
}

/** An event's price, only for a market fed by an exchange's public feed. */
export function eventPrice(marketKey: string, payload: Record<string, unknown>): number | undefined {
  const market = marketFromKey(marketKey);
  if (!market || !numbersAllowedFor(market.source)) return undefined;
  const price = Number(payload.price);
  return Number.isFinite(price) ? price : undefined;
}

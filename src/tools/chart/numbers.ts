/*
  The numbers a chart may hand the model, shared by the chart view (which
  computes them in the user's browser) and the server (which checks and
  describes them). Only for markets whose numbersAllowed is true
  (market.ts, numbersAllowedFor): there they are a handful of scalars, never
  an array of bars.

    last_price         the newest candle's close
    change_pct         from the day's open (00:00 UTC) to the last price
    visible_high/low   the extremes of the candles in the visible range
    indicator_values   each indicator's latest value per line, e.g.
                       { name: "RSI", values: { RSI: 38.2 } }

  No Node or DOM APIs here: the view bundles this file.
*/
import type { Timeframe } from "./market.js";

export type Bar = { time: number; open: number; high: number; low: number; close: number };

export type IndicatorValues = { name: string; values: Record<string, number> };

export type ChartNumbers = {
  last_price?: number;
  change_pct?: number;
  visible_high?: number;
  visible_low?: number;
  indicator_values?: IndicatorValues[];
};

/** The view-state fields that carry numbers (everything else in the state is words). */
export const NUMBER_FIELDS = ["last_price", "change_pct", "visible_high", "visible_low", "indicator_values"] as const;

const DAY_MS = 86_400_000;

/** Drops float noise (0.30000000000000004) while keeping every digit an exchange quotes. */
export function tidy(value: number): number {
  return Number(value.toPrecision(12));
}

/**
 * Last price, change since the day's open and the visible range's high and
 * low, from the candles the chart holds (ascending by time). The day's open
 * is the open of the candle that starts at 00:00 UTC today: on daily candles
 * the newest candle's own open; on intraday candles the one opening at
 * midnight, when it is loaded. Weekly candles have no day's open, so no change.
 */
export function priceNumbers(
  bars: readonly Bar[],
  visible: { from: number; to: number } | null,
  timeframe: Timeframe,
): Pick<ChartNumbers, "last_price" | "change_pct" | "visible_high" | "visible_low"> {
  const last = bars.at(-1);
  if (!last || !Number.isFinite(last.close) || last.close <= 0) return {};
  const out: Pick<ChartNumbers, "last_price" | "change_pct" | "visible_high" | "visible_low"> = { last_price: tidy(last.close) };

  let dayOpen: number | undefined;
  if (timeframe === "1d") dayOpen = last.open;
  else if (timeframe !== "1w") {
    const midnight = Math.floor(last.time / DAY_MS) * DAY_MS;
    for (let i = bars.length - 1; i >= 0 && bars[i].time >= midnight; i--) {
      if (bars[i].time === midnight) dayOpen = bars[i].open;
    }
  }
  if (dayOpen !== undefined && Number.isFinite(dayOpen) && dayOpen > 0) {
    out.change_pct = Math.round(((last.close - dayOpen) / dayOpen) * 10_000) / 100;
  }

  if (visible) {
    let high = -Infinity;
    let low = Infinity;
    for (const bar of bars) {
      if (bar.time < visible.from || bar.time > visible.to) continue;
      if (bar.high > high) high = bar.high;
      if (bar.low < low) low = bar.low;
    }
    if (Number.isFinite(high) && Number.isFinite(low)) {
      out.visible_high = tidy(high);
      out.visible_low = tidy(low);
    }
  }
  return out;
}

const SUFFIX: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

/** A value as Vela's data window formats it ("2,231.4", "−0.52", "1.2K") back to a number. */
export function readoutNumber(text: string): number | undefined {
  const cleaned = text
    .trim()
    .replace(/[−‒–]/g, "-")
    .replace(/[,\s  ]/g, "");
  const match = /^(-?\d+(?:\.\d+)?)([KMBT])?%?$/i.exec(cleaned);
  if (!match) return undefined;
  const value = Number(match[1]) * (match[2] ? SUFFIX[match[2].toUpperCase()] : 1);
  return Number.isFinite(value) ? tidy(value) : undefined;
}

/** Each indicator's latest values from Vela's data-window readout (volume is left out: it is not an indicator the model added). */
export function indicatorValuesFromReadout(
  groups: ReadonlyArray<{ name: string; rows: ReadonlyArray<{ label: string; value: string }> }>,
): IndicatorValues[] {
  const out: IndicatorValues[] = [];
  for (const group of groups) {
    if (/^vol(ume)?\b/i.test(group.name)) continue;
    const values: Record<string, number> = {};
    for (const row of group.rows.slice(0, 10)) {
      const value = readoutNumber(row.value);
      if (value !== undefined && row.label) values[row.label.slice(0, 40)] = value;
    }
    if (Object.keys(values).length) out.push({ name: group.name.slice(0, 60), values });
    if (out.length >= 30) break;
  }
  return out;
}

/** A number for a sentence: thousands separators and as many decimals as the value needs ("2,231.4", "0.00001234"). */
export function formatNumber(value: number): string {
  const abs = Math.abs(value);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : 8;
  const fixed = value.toFixed(decimals).replace(/\.?0+$/, "");
  const [whole, fraction] = fixed.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

/** "RSI 38.2" for a one-line indicator, "MACD: MACD 12.3, Signal 10.1" for several lines. */
function describeIndicator({ name, values }: IndicatorValues): string {
  const entries = Object.entries(values);
  // One line: its own label is the short name ("RSI" for "Relative Strength Index", "SMA" for "Moving Average").
  if (entries.length === 1) return `${entries[0][0] || name} ${formatNumber(entries[0][1])}`;
  return `${name}: ${entries.map(([label, value]) => `${label} ${formatNumber(value)}`).join(", ")}`;
}

/** The numbers in words: "Last 2,231.4 (-0.4% today). Visible range: high 2,310, low 2,180. RSI 38.2." */
export function describeNumbers(numbers: ChartNumbers): string {
  const parts: string[] = [];
  if (numbers.last_price !== undefined) {
    const change =
      numbers.change_pct !== undefined ? ` (${numbers.change_pct > 0 ? "+" : ""}${numbers.change_pct.toFixed(2).replace(/\.?0+$/, "")}% today)` : "";
    parts.push(`Last ${formatNumber(numbers.last_price)}${change}.`);
  }
  if (numbers.visible_high !== undefined && numbers.visible_low !== undefined) {
    parts.push(`Visible range: high ${formatNumber(numbers.visible_high)}, low ${formatNumber(numbers.visible_low)}.`);
  }
  if (numbers.indicator_values?.length) parts.push(`${numbers.indicator_values.map(describeIndicator).join("; ")}.`);
  return parts.join(" ");
}

/** Only the number fields of a state, or nothing when it has none. */
export function pickNumbers(state: ChartNumbers): ChartNumbers | undefined {
  const out: ChartNumbers = {};
  for (const key of NUMBER_FIELDS) if (state[key] !== undefined) (out as Record<string, unknown>)[key] = state[key];
  return Object.keys(out).length ? out : undefined;
}

/** A state without its number fields (for a market that is words-only, or for the app's words-only schema). */
export function withoutNumbers<T extends ChartNumbers>(state: T): Omit<T, (typeof NUMBER_FIELDS)[number]> {
  const copy = { ...state } as Record<string, unknown>;
  for (const key of NUMBER_FIELDS) delete copy[key];
  return copy as Omit<T, (typeof NUMBER_FIELDS)[number]>;
}

/* Small formatting helpers shared across domains. */

/** Drop null/undefined properties recursively — null means "not in the source document". */
export function compact<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => compact(item)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === null || entry === undefined) continue;
      out[key] = compact(entry);
    }
    return out as T;
  }
  return value;
}

/** 0.4567 → "45.7%". */
export function fmtPct(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** 12345.6, "usd" → "12,346 USD". */
export function fmtMoney(x: number, currency: string): string {
  return `${Math.round(x).toLocaleString("en-US")} ${currency.toUpperCase()}`;
}

/** Bytes → "12.3 MB". */
export function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

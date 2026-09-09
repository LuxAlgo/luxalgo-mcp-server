/*
  The query engine over streamed dump rows: filters (ticker, free text, exact
  field matches, event-date range), a bounded newest/oldest selection so an
  unfiltered scan of a 300k-row shard keeps only the page it needs, and
  id-based dedupe for years split across the live tree and an archive.
*/
import { valuesAt, type TrackerDataset, type TrackerRow } from "./catalog.js";
import { streamShardRows, type ShardRef } from "./dumps.js";

export type Scalar = string | number | boolean;

export interface RowFilters {
  ticker?: string;
  text?: string;
  where?: Record<string, Scalar>;
  since?: string;
  until?: string;
}

function normalizeTicker(value: string): string {
  return value.trim().toUpperCase();
}

export function matchesTicker(dataset: TrackerDataset, row: TrackerRow, ticker: string): boolean {
  const wanted = normalizeTicker(ticker);
  for (const path of dataset.tickerPaths) {
    for (const value of valuesAt(row, path)) {
      if (typeof value === "string" && normalizeTicker(value) === wanted) return true;
    }
  }
  return false;
}

export function matchesText(dataset: TrackerDataset, row: TrackerRow, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (needle.length === 0) return true;
  for (const path of dataset.textPaths) {
    for (const value of valuesAt(row, path)) {
      if (typeof value === "string" && value.toLowerCase().includes(needle)) return true;
    }
  }
  return false;
}

export function matchesWhere(row: TrackerRow, where: Record<string, Scalar>): boolean {
  for (const [path, expected] of Object.entries(where)) {
    const values = valuesAt(row, path);
    const hit = values.some((value) => {
      if (typeof expected === "string" && typeof value === "string") {
        return value.toLowerCase() === expected.toLowerCase();
      }
      return value === expected;
    });
    if (!hit) return false;
  }
  return true;
}

export function matchesDateRange(date: string | null, since?: string, until?: string): boolean {
  if (!since && !until) return true;
  if (!date) return false;
  // ISO date strings (and their YYYY / YYYY-MM prefixes) compare lexicographically.
  if (since && date < since && !since.startsWith(date)) return false;
  if (until && date.slice(0, until.length) > until) return false;
  return true;
}

export function rowMatches(dataset: TrackerDataset, row: TrackerRow, filters: RowFilters): boolean {
  if (filters.ticker && !matchesTicker(dataset, row, filters.ticker)) return false;
  if (filters.text && !matchesText(dataset, row, filters.text)) return false;
  if (filters.where && !matchesWhere(row, filters.where)) return false;
  if (
    (filters.since || filters.until) &&
    !matchesDateRange(dataset.eventDate(row), filters.since, filters.until)
  ) {
    return false;
  }
  return true;
}

export type SortOrder = "newest" | "oldest";

/**
 * Keeps the `capacity` best rows by event date without holding the rest.
 * Rows with no event date sort last in either order. Ties keep arrival order.
 */
export class BoundedSelection {
  private readonly items: { key: string; row: TrackerRow }[] = [];

  constructor(
    private readonly capacity: number,
    private readonly order: SortOrder,
  ) {}

  private better(a: string, b: string): boolean {
    // Empty keys (no date) are always worse than any date.
    if (a === "" || b === "") return b === "" && a !== "";
    return this.order === "newest" ? a > b : a < b;
  }

  push(row: TrackerRow, date: string | null): void {
    const key = date ?? "";
    if (this.items.length >= this.capacity) {
      const worst = this.items[this.items.length - 1] as { key: string; row: TrackerRow };
      if (!this.better(key, worst.key)) return;
      this.items.pop();
    }
    // Binary insert: keep items sorted best-first.
    let low = 0;
    let high = this.items.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.better(key, (this.items[mid] as { key: string }).key)) high = mid;
      else low = mid + 1;
    }
    this.items.splice(low, 0, { key, row });
  }

  rows(): TrackerRow[] {
    return this.items.map((item) => item.row);
  }
}

export interface QueryOptions {
  filters: RowFilters;
  order: SortOrder;
  limit: number;
  offset: number;
}

export interface ScannedShard extends ShardRef {
  rows: number;
  matched: number;
}

export interface QueryResult {
  matched: number;
  rows: TrackerRow[];
  scanned: ScannedShard[];
}

/** Streams every shard once, filtering as rows arrive and keeping only the requested page. */
export async function runQuery(
  dataset: TrackerDataset,
  shards: ShardRef[],
  options: QueryOptions,
): Promise<QueryResult> {
  const selection = new BoundedSelection(options.offset + options.limit, options.order);
  const seen = new Set<string>();
  const scanned: ScannedShard[] = [];
  let matched = 0;
  for (const shard of shards) {
    const stats: ScannedShard = { ...shard, rows: 0, matched: 0 };
    for await (const row of streamShardRows(shard)) {
      stats.rows += 1;
      if (!rowMatches(dataset, row, options.filters)) continue;
      const id = typeof row.id === "string" ? row.id : null;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      matched += 1;
      stats.matched += 1;
      selection.push(row, dataset.eventDate(row));
    }
    scanned.push(stats);
  }
  return { matched, rows: selection.rows().slice(options.offset), scanned };
}

/** In-memory variant for rows already loaded (latest.json). */
export function selectRows(
  dataset: TrackerDataset,
  rows: TrackerRow[],
  options: QueryOptions,
): { matched: number; rows: TrackerRow[] } {
  const selection = new BoundedSelection(options.offset + options.limit, options.order);
  let matched = 0;
  for (const row of rows) {
    if (!rowMatches(dataset, row, options.filters)) continue;
    matched += 1;
    selection.push(row, dataset.eventDate(row));
  }
  return { matched, rows: selection.rows().slice(options.offset) };
}

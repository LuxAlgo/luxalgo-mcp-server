/*
  Read access to the Market Trackers dumps — the CC0 data the pipeline
  publishes to github.com/LuxAlgo/market-trackers-data. Two places hold data:

  - the repository's main branch: the live layout the daily publish refreshes
    (year shards `<exportDir>/snapshot-<YYYY>.json.gz`, `latest.json`, and
    the root `manifest.json` index);
  - GitHub Releases tagged `archive-<source>-<from>-<to>`: deep-history year
    shards too large for the working tree. The daily publish indexes them in
    the root `archives.json` (newest complete shard per dataset and year), so
    this server never needs the GitHub API.

  Keyless and read-only. Shards stream (see json-array-stream.ts); small ones
  are cached compressed for a few minutes because warm serverless instances
  answer many calls against the same current-year files.
*/
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";
import { iterateJsonArray } from "./json-array-stream.js";
import {
  TRACKER_DATASETS,
  type TrackerDataset,
  type TrackerDatasetId,
  type TrackerRow,
} from "./catalog.js";

export const DUMPS_REPO = process.env.MARKET_TRACKERS_DATA_REPO ?? "LuxAlgo/market-trackers-data";
export const DUMPS_ORIGIN =
  process.env.MARKET_TRACKERS_DUMPS_ORIGIN ??
  `https://raw.githubusercontent.com/${DUMPS_REPO}/main`;
export const RELEASES_ORIGIN = `https://github.com/${DUMPS_REPO}/releases/download`;
export const DUMPS_REPO_URL = `https://github.com/${DUMPS_REPO}`;

const INDEX_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 50_000;

/** Compressed bytes one tool call may stream in total (keeps calls well under a minute). */
export const MAX_BYTES_PER_CALL = 64 * 1024 * 1024;
/** Shards up to this size are kept compressed in memory after a fetch. */
const CACHEABLE_SHARD_BYTES = 6 * 1024 * 1024;
const SHARD_CACHE_BYTES = 48 * 1024 * 1024;
const SHARD_CACHE_TTL_MS = 10 * 60 * 1000;

export class DumpsError extends Error {}

export type ManifestDataset = {
  title: string;
  exportDir: string;
  rows: number;
  lastIngestedAt: string | null;
  stale: boolean;
  snapshots: { file: string; rows: number }[];
  feed: string | null;
  entityFeeds?: { byTicker: number; byMember: number };
};

export type ManifestSource = {
  implementedDatasets: string[];
  lastSyncOk: boolean | null;
  lastSyncAt: string | null;
  lastCanaryStatus: string | null;
  lastCanaryAt: string | null;
  watermarks: Record<string, string>;
};

export type DumpsManifest = {
  generatedAt: string;
  schemaVersion: number;
  datasets: Record<string, ManifestDataset>;
  sources: Record<string, ManifestSource>;
};

export type ArchiveShard = {
  tag: string;
  asset: string;
  bytes: number;
  updatedAt: string;
};

export type ArchivesIndex = {
  generatedAt: string;
  repository: string;
  datasets: Record<string, { years: Record<string, ArchiveShard> }>;
  releases: { tag: string; source: string; from: string; to: string; publishedAt: string; assets: number }[];
};

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const response = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
  if (response.status === 404) return null;
  if (!response.ok) throw new DumpsError(`Dumps ${response.status} for ${url}`);
  return (await response.json()) as T;
}

let manifestCache: { at: number; value: DumpsManifest } | null = null;
let archivesCache: { at: number; value: ArchivesIndex | null } | null = null;

export async function getManifest(): Promise<DumpsManifest> {
  if (manifestCache && Date.now() - manifestCache.at < INDEX_TTL_MS) return manifestCache.value;
  const manifest = await fetchJson<DumpsManifest>(`${DUMPS_ORIGIN}/manifest.json`);
  if (!manifest) throw new DumpsError("The dumps manifest is missing (manifest.json returned 404)");
  manifestCache = { at: Date.now(), value: manifest };
  return manifest;
}

/** Null until the first daily publish that writes archives.json. */
export async function getArchivesIndex(): Promise<ArchivesIndex | null> {
  if (archivesCache && Date.now() - archivesCache.at < INDEX_TTL_MS) return archivesCache.value;
  const index = await fetchJson<ArchivesIndex>(`${DUMPS_ORIGIN}/archives.json`);
  archivesCache = { at: Date.now(), value: index };
  return index;
}

export function mainShardUrl(dataset: TrackerDataset, year: number): string {
  return `${DUMPS_ORIGIN}/${dataset.exportDir}/snapshot-${year}.json.gz`;
}

export function latestUrl(dataset: TrackerDataset): string {
  return `${DUMPS_ORIGIN}/${dataset.exportDir}/latest.json`;
}

export function archiveAssetUrl(shard: ArchiveShard): string {
  return `${RELEASES_ORIGIN}/${shard.tag}/${shard.asset}`;
}

/** Garbage event dates in source documents produce stray shards (year 0012, 2047…); ignore them. */
export function isSaneYear(year: number, now = new Date()): boolean {
  return Number.isInteger(year) && year >= 1900 && year <= now.getUTCFullYear() + 1;
}

const SHARD_FILE = /^snapshot-(\d{4})\.json\.gz$/;

export type YearCoverage = {
  year: number;
  /** Row count of the live (main-branch) shard, when one exists. */
  live?: { rows: number };
  /** The deep-history release shard, when one exists. */
  archive?: ArchiveShard;
};

/** Every year a dataset has data for, merged across the live tree and the archives. */
export function coverageFor(
  id: TrackerDatasetId,
  manifest: DumpsManifest,
  archives: ArchivesIndex | null,
  now = new Date(),
): YearCoverage[] {
  const byYear = new Map<number, YearCoverage>();
  for (const shard of manifest.datasets[id]?.snapshots ?? []) {
    const match = SHARD_FILE.exec(shard.file);
    if (!match) continue;
    const year = Number(match[1]);
    if (!isSaneYear(year, now) || shard.rows === 0) continue;
    byYear.set(year, { year, live: { rows: shard.rows } });
  }
  for (const [yearText, shard] of Object.entries(archives?.datasets[id]?.years ?? {})) {
    const year = Number(yearText);
    if (!isSaneYear(year, now) || shard.bytes === 0) continue;
    const entry = byYear.get(year) ?? { year };
    entry.archive = shard;
    byYear.set(year, entry);
  }
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}

/** Compact "1999–2004, 2006–2026" rendering of a year list. */
export function yearRanges(years: number[]): string {
  const sorted = [...new Set(years)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start: number | null = null;
  let prev: number | null = null;
  for (const year of sorted) {
    if (start === null || prev === null || year !== prev + 1) {
      if (start !== null && prev !== null) parts.push(start === prev ? `${start}` : `${start}–${prev}`);
      start = year;
    }
    prev = year;
  }
  if (start !== null && prev !== null) parts.push(start === prev ? `${start}` : `${start}–${prev}`);
  return parts.join(", ");
}

/* ------------------------------------------------------------------ *
 * Shard streaming
 * ------------------------------------------------------------------ */

export type ShardRef = {
  year: number;
  location: "live" | "archive";
  url: string;
  /** Compressed size when known before the fetch (archives carry it; live shards are HEAD-probed). */
  bytes: number | null;
};

async function headSize(url: string): Promise<number | null> {
  try {
    const response = await fetchWithTimeout(url, { method: "HEAD" });
    if (!response.ok) return null;
    const length = Number(response.headers.get("content-length"));
    return Number.isFinite(length) && length > 0 ? length : null;
  } catch {
    return null;
  }
}

/**
 * The shards that answer a query for `years`. Both locations are read when
 * both hold a year (the live shard carries the current year's daily rows,
 * the archive the deep history; a year can be split across them) and rows
 * dedupe by id downstream.
 */
export async function planShards(
  dataset: TrackerDataset,
  coverage: YearCoverage[],
  years: number[],
): Promise<{ shards: ShardRef[]; missingYears: number[] }> {
  const shards: ShardRef[] = [];
  const missingYears: number[] = [];
  const byYear = new Map(coverage.map((entry) => [entry.year, entry]));
  for (const year of years) {
    const entry = byYear.get(year);
    if (!entry) {
      missingYears.push(year);
      continue;
    }
    if (entry.live) {
      shards.push({ year, location: "live", url: mainShardUrl(dataset, year), bytes: null });
    }
    if (entry.archive) {
      shards.push({
        year,
        location: "archive",
        url: archiveAssetUrl(entry.archive),
        bytes: entry.archive.bytes,
      });
    }
  }
  await Promise.all(
    shards
      .filter((shard) => shard.bytes === null)
      .map(async (shard) => {
        shard.bytes = cachedSize(shard.url) ?? (await headSize(shard.url));
      }),
  );
  return { shards, missingYears };
}

type CacheEntry = { at: number; bytes: Buffer };
const shardCache = new Map<string, CacheEntry>();
let shardCacheBytes = 0;

function cachedSize(url: string): number | null {
  const entry = shardCache.get(url);
  return entry ? entry.bytes.byteLength : null;
}

function cacheGet(url: string): Buffer | null {
  const entry = shardCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.at > SHARD_CACHE_TTL_MS) {
    shardCache.delete(url);
    shardCacheBytes -= entry.bytes.byteLength;
    return null;
  }
  // Refresh recency (Map iteration order is insertion order).
  shardCache.delete(url);
  shardCache.set(url, entry);
  return entry.bytes;
}

function cacheSet(url: string, bytes: Buffer): void {
  if (bytes.byteLength > CACHEABLE_SHARD_BYTES) return;
  while (shardCacheBytes + bytes.byteLength > SHARD_CACHE_BYTES && shardCache.size > 0) {
    const oldest = shardCache.keys().next().value as string;
    const evicted = shardCache.get(oldest);
    shardCache.delete(oldest);
    if (evicted) shardCacheBytes -= evicted.bytes.byteLength;
  }
  shardCache.set(url, { at: Date.now(), bytes });
  shardCacheBytes += bytes.byteLength;
}

async function* bufferChunks(bytes: Buffer): AsyncGenerator<Uint8Array> {
  yield bytes;
}

/**
 * Streams the rows of one gzipped shard. Small shards are read whole into
 * the compressed cache first; large ones stream straight from the network.
 * Null when the shard does not exist.
 */
export async function* streamShardRows(
  shard: ShardRef,
): AsyncGenerator<TrackerRow, void, undefined> {
  const cached = cacheGet(shard.url);
  let compressed: AsyncIterable<Uint8Array>;
  if (cached) {
    compressed = bufferChunks(cached);
  } else {
    const response = await fetchWithTimeout(shard.url, { headers: { accept: "application/gzip, */*" } });
    if (response.status === 404) return;
    if (!response.ok || !response.body) throw new DumpsError(`Dumps ${response.status} for ${shard.url}`);
    const size = Number(response.headers.get("content-length"));
    if (Number.isFinite(size) && size > 0 && size <= CACHEABLE_SHARD_BYTES) {
      const bytes = Buffer.from(await response.arrayBuffer());
      cacheSet(shard.url, bytes);
      compressed = bufferChunks(bytes);
    } else {
      compressed = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
    }
  }
  const gunzip = createGunzip();
  const source = Readable.from(compressed);
  source.pipe(gunzip);
  source.on("error", (error) => gunzip.destroy(error));
  for await (const element of iterateJsonArray(gunzip)) {
    if (element !== null && typeof element === "object" && !Array.isArray(element)) {
      yield element as TrackerRow;
    }
  }
}

/** The newest daily delta (`latest.json`) — plain JSON, small; null for snapshot-only datasets or when absent. */
export async function fetchLatestRows(dataset: TrackerDataset): Promise<TrackerRow[] | null> {
  if (dataset.snapshotOnly) return null;
  const rows = await fetchJson<unknown>(latestUrl(dataset));
  if (!Array.isArray(rows)) return null;
  return rows.filter(
    (row): row is TrackerRow => row !== null && typeof row === "object" && !Array.isArray(row),
  );
}

export function datasetDef(id: TrackerDatasetId): TrackerDataset {
  return TRACKER_DATASETS[id];
}

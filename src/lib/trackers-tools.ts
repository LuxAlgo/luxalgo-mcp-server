/*
  The Market Trackers tools: the public record of US markets — congressional
  trades, insider filings, 13F holdings, government contracts and grants,
  lobbying, short-sale volume, patents, clinical trials, FDA drug events,
  futures positioning, federal bills, campaign finance, hearing transcripts,
  Federal Reserve communications — read straight from the CC0 dumps the
  LuxAlgo Market Trackers pipeline publishes (github.com/LuxAlgo/market-trackers-data).

  Keyless and read-only. Every row carries `provenance.sourceUrl`, a deep link
  to the primary document it was parsed from; amounts disclosed as ranges stay
  ranges; there are no signals, scores, or predictions anywhere in the data.
*/
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  TICKER_DATASETS,
  TRACKER_DATASETS,
  TRACKER_DATASET_IDS,
  type TrackerDataset,
  type TrackerDatasetId,
  type TrackerRow,
} from "./trackers/catalog.js";
import {
  DUMPS_ORIGIN,
  DUMPS_REPO_URL,
  MAX_BYTES_PER_CALL,
  coverageFor,
  fetchLatestRows,
  getArchivesIndex,
  getManifest,
  latestUrl,
  planShards,
  yearRanges,
  type ArchivesIndex,
  type DumpsManifest,
  type ShardRef,
  type YearCoverage,
} from "./trackers/dumps.js";
import { runQuery, selectRows, type RowFilters, type SortOrder } from "./trackers/query.js";

const MAX_YEARS_PER_CALL = 8;
/** Archive shards larger than this are left to trackers_query in a ticker overview. */
const OVERVIEW_ARCHIVE_SHARD_BYTES = 8 * 1024 * 1024;

const LICENSE = {
  license: "CC0-1.0",
  repository: DUMPS_REPO_URL,
  note: "Public-record data with primary-source receipts (provenance.sourceUrl on every row). Data only: no signals, scores, or predictions.",
};

function json(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

/** Drop null/undefined properties recursively — null means "not in the source document". */
function compact<T>(value: T): T {
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

function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/** Network and format failures surface as clean tool errors, never as raw exceptions. */
async function guarded<T>(run: () => Promise<T>): Promise<T | ReturnType<typeof toolError>> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return toolError(`Market Trackers dumps unavailable: ${message}`);
  }
}

const datasetIdSchema = z.enum(TRACKER_DATASET_IDS);
const dateSchema = z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, "YYYY, YYYY-MM or YYYY-MM-DD");

const filterShape = {
  ticker: z
    .string()
    .min(1)
    .max(12)
    .optional()
    .describe(
      "Trading symbol, case-insensitive (e.g. 'NVDA'); matches the dataset's ticker field(s). Only datasets flagged tickerSearchable carry tickers.",
    ),
  text: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Case-insensitive substring over the dataset's name/title fields (member, insider, issuer, recipient, registrant and client, sponsor, assignee, bill title, …); see textPaths in trackers_datasets",
    ),
  where: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe(
      "Exact field matches by dot path, e.g. {\"side\":\"buy\"}, {\"member.state\":\"CA\"}, {\"code\":\"P\"}, {\"formType\":\"4\"}; string comparisons are case-insensitive, arrays match when any element does",
    ),
  since: dateSchema.optional().describe("Earliest event date (YYYY-MM-DD, YYYY-MM or YYYY), inclusive"),
  until: dateSchema.optional().describe("Latest event date, inclusive"),
};

const pageShape = {
  sort: z.enum(["newest", "oldest"]).optional().describe("Order by event date (default newest)"),
  limit: z.number().int().min(1).max(100).optional().describe("Rows to return (default 25, max 100)"),
  offset: z.number().int().min(0).optional().describe("Rows to skip, for paging (default 0)"),
};

type Indexes = { manifest: DumpsManifest; archives: ArchivesIndex | null };

async function loadIndexes(): Promise<Indexes> {
  const [manifest, archives] = await Promise.all([getManifest(), getArchivesIndex()]);
  return { manifest, archives };
}

function summarizeDataset(
  id: TrackerDatasetId,
  { manifest, archives }: Indexes,
  detailed: boolean,
): Record<string, unknown> {
  const def = TRACKER_DATASETS[id];
  const live = manifest.datasets[id];
  const coverage = coverageFor(id, manifest, archives);
  const liveYears = coverage.filter((entry) => entry.live).map((entry) => entry.year);
  const archiveYears = coverage.filter((entry) => entry.archive).map((entry) => entry.year);
  const summary: Record<string, unknown> = {
    id,
    title: def.title,
    description: def.description,
    primarySource: def.primarySource,
    rows: live?.rows ?? 0,
    lastIngestedAt: live?.lastIngestedAt ?? null,
    stale: live?.stale ?? true,
    years: yearRanges(coverage.map((entry) => entry.year)) || null,
    liveYears: yearRanges(liveYears) || null,
    archiveYears: yearRanges(archiveYears) || null,
    tickerSearchable: def.tickerPaths.length > 0,
    snapshotOnly: def.snapshotOnly ?? false,
  };
  if (!detailed) return summary;
  return {
    ...summary,
    exportDir: def.exportDir,
    dumps: {
      manifest: `${DUMPS_ORIGIN}/manifest.json`,
      latest: def.snapshotOnly ? null : latestUrl(def),
      yearShard: `${DUMPS_ORIGIN}/${def.exportDir}/snapshot-<YYYY>.json.gz`,
    },
    fields: def.fields,
    tickerPaths: def.tickerPaths,
    textPaths: def.textPaths,
    caveats: def.caveats,
    coverage: coverage.map((entry) => ({
      year: entry.year,
      liveRows: entry.live?.rows,
      archiveBytes: entry.archive?.bytes,
      archiveTag: entry.archive?.tag,
    })),
    sources: def.sources.map((source) => {
      const health = manifest.sources[source];
      return {
        id: source,
        lastSyncOk: health?.lastSyncOk ?? null,
        lastSyncAt: health?.lastSyncAt ?? null,
        lastCanaryStatus: health?.lastCanaryStatus ?? null,
        lastCanaryAt: health?.lastCanaryAt ?? null,
      };
    }),
  };
}

/** Which years a query reads: explicit years, else the years a date range spans, else the newest year with data. */
function resolveYears(
  args: { years?: number[]; since?: string; until?: string },
  coverage: YearCoverage[],
): { years: number[]; error?: string } {
  const covered = coverage.map((entry) => entry.year);
  const newest = covered[covered.length - 1] as number;
  if (args.years && args.years.length > 0) {
    const years = [...new Set(args.years)].sort((a, b) => a - b);
    if (years.length > MAX_YEARS_PER_CALL) {
      return { years: [], error: `At most ${MAX_YEARS_PER_CALL} years per call.` };
    }
    return { years };
  }
  if (args.since || args.until) {
    const from = args.since ? Number(args.since.slice(0, 4)) : (covered[0] as number);
    const to = args.until ? Number(args.until.slice(0, 4)) : newest;
    const years = covered.filter((year) => year >= from && year <= to);
    if (years.length === 0) {
      return { years: [], error: `No data between ${from} and ${to}; years with data: ${yearRanges(covered)}.` };
    }
    if (years.length > MAX_YEARS_PER_CALL) {
      return {
        years: [],
        error:
          `The since/until range spans ${years.length} years with data (${yearRanges(years)}); ` +
          `at most ${MAX_YEARS_PER_CALL} per call — narrow the range or pass years explicitly.`,
      };
    }
    return { years };
  }
  return { years: [newest] };
}

function overBudgetError(shards: ShardRef[], totalBytes: number): string {
  const listed = shards
    .map((shard) => `${shard.year} ${shard.location}${shard.bytes === null ? "" : ` ${mb(shard.bytes)}`}`)
    .join("; ");
  return (
    `This selection would stream ${mb(totalBytes)} of compressed data (${listed}); the per-call budget is ` +
    `${mb(MAX_BYTES_PER_CALL)}. Ask for fewer years — deep-history years are large, so read them one at a time ` +
    "(the ticker/text/where filters apply within whatever years you pick)."
  );
}

function queryNotes(def: TrackerDataset, scanned: ShardRef[], archives: ArchivesIndex | null): string[] {
  const notes = [...def.caveats];
  const years = new Set(scanned.map((shard) => shard.year));
  for (const year of years) {
    const locations = scanned.filter((shard) => shard.year === year).map((shard) => shard.location);
    if (locations.includes("live") && locations.includes("archive")) {
      notes.push(
        `${year} is split across the live tree (daily rows) and a deep-history archive; both were read and rows were deduplicated by id.`,
      );
    }
  }
  if (!archives) {
    notes.push(
      "No deep-history archive index is published yet; only the live tree was searched. Years listed as archiveYears in trackers_datasets become available once archives.json is published.",
    );
  }
  return notes;
}

export function registerTrackersTools(server: McpServer) {
  server.registerTool(
    "trackers_datasets",
    {
      title: "List Market Trackers datasets",
      description:
        "The Market Trackers catalog: every dataset of US public-record market data the LuxAlgo pipeline publishes as CC0 dumps — congressional trades, insider (Forms 3/4/5) transactions, 13F holdings, federal contracts and grants, lobbying filings, FINRA short-sale volume, granted patents, clinical trials, FDA drug events, CFTC positioning, federal bills, FEC campaign finance, hearing transcripts, Federal Reserve communications, committee assignments, Wikipedia pageviews. Returns each dataset's row count, freshness, the years with data (live tree vs deep-history archives), and whether it is ticker-searchable. Pass dataset for the full field roster, filterable paths, caveats, per-year coverage, source health, and dump URLs — read it before composing trackers_query filters.",
      inputSchema: {
        dataset: datasetIdSchema.optional().describe("One dataset for the detailed view; omit to list all"),
      },
    },
    async ({ dataset }) =>
      guarded(async () => {
        const indexes = await loadIndexes();
        const ids: TrackerDatasetId[] = dataset ? [dataset] : [...TRACKER_DATASET_IDS];
        return json(
          compact({
            generatedAt: indexes.manifest.generatedAt,
            schemaVersion: indexes.manifest.schemaVersion,
            archivesIndexedAt: indexes.archives?.generatedAt ?? null,
            ...LICENSE,
            datasets: ids.map((id) => summarizeDataset(id, indexes, Boolean(dataset))),
            ...(dataset ? {} : { tickerSearchable: TICKER_DATASETS }),
          }),
        );
      }),
  );

  server.registerTool(
    "trackers_query",
    {
      title: "Query a Market Trackers dataset",
      description:
        "Search one Market Trackers dataset by ticker, free text, exact field values, and event-date range, with paging and newest/oldest ordering. Data is read from year-sharded CC0 dumps: pass years (or since/until) to choose which years to read — default is the newest year with data. Deep-history years (see archiveYears in trackers_datasets) can be tens of MB compressed each, so read them one or two at a time; the tool refuses selections over its byte budget and says how to narrow. Every row carries provenance.sourceUrl (the SEC filing, disclosure, award, or record it came from). Examples: insider purchases at NVDA in 2024 → dataset insider-transactions, ticker NVDA, years [2024], where {code: 'P'}; a senator's trades → congress-trades, text 'Tuberville'; who lobbied on a bill → lobbying-filings, text 'H.R.1234'.",
      inputSchema: {
        dataset: datasetIdSchema.describe("Dataset id, from trackers_datasets"),
        years: z
          .array(z.number().int().min(1900).max(2100))
          .max(MAX_YEARS_PER_CALL)
          .optional()
          .describe(
            `Event years to read (max ${MAX_YEARS_PER_CALL}); default is the newest year with data. Prefer one year at a time for deep-history datasets.`,
          ),
        ...filterShape,
        ...pageShape,
      },
    },
    async (args) =>
      guarded(async () => {
        const def = TRACKER_DATASETS[args.dataset];
        const indexes = await loadIndexes();
        const coverage = coverageFor(args.dataset, indexes.manifest, indexes.archives);
        if (coverage.length === 0) {
          return toolError(`${def.title} has no published rows yet; check trackers_datasets for freshness.`);
        }
        const resolved = resolveYears(args, coverage);
        if (resolved.error) return toolError(resolved.error);

        const { shards, missingYears } = await planShards(def, coverage, resolved.years);
        if (shards.length === 0) {
          return toolError(
            `${def.title} has no data for ${yearRanges(resolved.years)}; years with data: ${yearRanges(coverage.map((entry) => entry.year))}.`,
          );
        }
        const totalBytes = shards.reduce((sum, shard) => sum + (shard.bytes ?? 0), 0);
        if (totalBytes > MAX_BYTES_PER_CALL) return toolError(overBudgetError(shards, totalBytes));

        const filters: RowFilters = {
          ticker: args.ticker,
          text: args.text,
          where: args.where,
          since: args.since,
          until: args.until,
        };
        const order: SortOrder = args.sort ?? "newest";
        const limit = args.limit ?? 25;
        const offset = args.offset ?? 0;
        const result = await runQuery(def, shards, { filters, order, limit, offset });
        return json(
          compact({
            dataset: def.id,
            title: def.title,
            years: resolved.years,
            filters: compact(filters),
            sort: order,
            matched: result.matched,
            returned: result.rows.length,
            offset,
            hasMore: offset + result.rows.length < result.matched,
            rows: result.rows,
            scanned: result.scanned.map((shard) => ({
              year: shard.year,
              location: shard.location,
              url: shard.url,
              bytes: shard.bytes,
              rows: shard.rows,
              matched: shard.matched,
            })),
            missingYears: missingYears.length > 0 ? missingYears : undefined,
            notes: queryNotes(def, result.scanned, indexes.archives),
            ...LICENSE,
          }),
        );
      }),
  );

  server.registerTool(
    "trackers_latest",
    {
      title: "Newest Market Trackers rows",
      description:
        "What the last daily publish added to one dataset — the newest ingestion day's rows (the dumps' latest.json), optionally narrowed by ticker or text. The cheapest way to see what is new: today's insider filings, this week's congressional disclosures, the latest lobbying registrations. Not available for snapshot-only bulk datasets (patents); use trackers_query there.",
      inputSchema: {
        dataset: datasetIdSchema.describe("Dataset id, from trackers_datasets"),
        ticker: filterShape.ticker,
        text: filterShape.text,
        where: filterShape.where,
        ...pageShape,
      },
    },
    async (args) =>
      guarded(async () => {
        const def = TRACKER_DATASETS[args.dataset];
        if (def.snapshotOnly) {
          return toolError(
            `${def.title} is a snapshot-only bulk dataset with no daily delta; use trackers_query with a year instead.`,
          );
        }
        const [rows, manifest] = await Promise.all([fetchLatestRows(def), getManifest()]);
        if (!rows) return toolError(`${def.title} has no latest.json published yet.`);
        const order: SortOrder = args.sort ?? "newest";
        const limit = args.limit ?? 25;
        const offset = args.offset ?? 0;
        const filters: RowFilters = { ticker: args.ticker, text: args.text, where: args.where };
        const selected = selectRows(def, rows, { filters, order, limit, offset });
        return json(
          compact({
            dataset: def.id,
            title: def.title,
            lastIngestedAt: manifest.datasets[def.id]?.lastIngestedAt ?? null,
            rowsInDelta: rows.length,
            filters: compact(filters),
            matched: selected.matched,
            returned: selected.rows.length,
            offset,
            hasMore: offset + selected.rows.length < selected.matched,
            rows: selected.rows,
            source: latestUrl(def),
            notes: def.caveats,
            ...LICENSE,
          }),
        );
      }),
  );

  server.registerTool(
    "trackers_ticker",
    {
      title: "Ticker across Market Trackers",
      description:
        "One ticker across every ticker-bearing Market Trackers dataset for one year (default: the current year): insider transactions, congressional trades, 13F holdings, federal contracts and grants, lobbying filings by the company, short-sale volume, clinical trials, FDA events, patents, Wikipedia pageviews. Returns per-dataset match counts with the newest rows of each — a public-record dossier from primary sources. Deep-history archive years too large for one fan-out are listed under skipped with the trackers_query call that reads them.",
      inputSchema: {
        ticker: z.string().min(1).max(12).describe("Trading symbol, e.g. 'NVDA'"),
        year: z
          .number()
          .int()
          .min(1900)
          .max(2100)
          .optional()
          .describe("Event year to read (default: the current year)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe("Newest rows to include per dataset (default 5)"),
      },
    },
    async ({ ticker, year, limit }) =>
      guarded(async () => {
        const indexes = await loadIndexes();
        const target = year ?? new Date().getUTCFullYear();
        const perDataset = limit ?? 5;
        const skipped: Record<string, unknown>[] = [];
        const results = await Promise.all(
          TICKER_DATASETS.map(async (id) => {
            const def = TRACKER_DATASETS[id];
            const coverage = coverageFor(id, indexes.manifest, indexes.archives);
            const { shards } = await planShards(def, coverage, [target]);
            const readable = shards.filter(
              (shard) =>
                shard.location === "live" ||
                (shard.bytes !== null && shard.bytes <= OVERVIEW_ARCHIVE_SHARD_BYTES),
            );
            for (const shard of shards) {
              if (readable.includes(shard)) continue;
              skipped.push({
                dataset: id,
                year: target,
                reason: `deep-history shard is ${shard.bytes === null ? "large" : mb(shard.bytes)}; read it with trackers_query`,
                query: { dataset: id, ticker, years: [target] },
              });
            }
            if (readable.length === 0) return { dataset: id, title: def.title, matched: 0, rows: [] as TrackerRow[] };
            const result = await runQuery(def, readable, {
              filters: { ticker },
              order: "newest",
              limit: perDataset,
              offset: 0,
            });
            return { dataset: id, title: def.title, matched: result.matched, rows: result.rows };
          }),
        );
        return json(
          compact({
            ticker: ticker.trim().toUpperCase(),
            year: target,
            datasets: results,
            skipped: skipped.length > 0 ? skipped : undefined,
            notes: [
              "Ticker mappings for contracts, grants, lobbying, trials, FDA events and patents are best-effort against a curated map of public companies; a zero there means unmapped or no activity, not proof of absence.",
            ],
            ...LICENSE,
          }),
        );
      }),
  );
}

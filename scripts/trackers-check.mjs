/*
  Offline checks for the Market Trackers engine — the pieces whose failure
  modes are silent data loss rather than a thrown error: the streaming JSON
  array splitter (chunk boundaries inside strings, escapes, nested brackets,
  and multi-byte characters), the bounded newest/oldest selection, the
  live+archive coverage merge with stray-year filtering, and the date-range
  and dot-path semantics. No network. Exits non-zero on any failure.
*/
import { gzipSync } from "node:zlib";
import { JsonArraySplitter, iterateJsonArray } from "../dist/lib/trackers/json-array-stream.js";
import { BoundedSelection, matchesDateRange, matchesWhere } from "../dist/lib/trackers/query.js";
import { coverageFor, isSaneYear, yearRanges } from "../dist/lib/trackers/dumps.js";
import { TRACKER_DATASETS, valuesAt } from "../dist/lib/trackers/catalog.js";

let failures = 0;
function check(label, condition, detail = "") {
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failures++;
  console.log(`${status}  ${label}${detail ? ` — ${detail}` : ""}`);
}

/* ---------------- JSON array splitter ---------------- */

const rows = [
  { id: "a", text: 'quote " and bracket ] inside }', nested: { list: [1, 2, { deep: "]}" }] } },
  { id: "b", emoji: "日本語 🚀 ünïcödé", n: -12.5e3, flag: true, nothing: null },
  { id: "c", empty: {}, arr: [] },
];
const encoded = Buffer.from(JSON.stringify(rows), "utf8");

// Every possible split point — including inside strings and multi-byte chars.
let splitterOk = true;
for (let cut = 1; cut < encoded.length; cut++) {
  const splitter = new JsonArraySplitter();
  const decoder = new (await import("node:string_decoder")).StringDecoder("utf8");
  const out = [
    ...splitter.push(decoder.write(encoded.subarray(0, cut))),
    ...splitter.push(decoder.write(encoded.subarray(cut))),
    ...splitter.push(decoder.end()),
    ...splitter.finish(),
  ];
  if (JSON.stringify(out) !== JSON.stringify(rows)) {
    splitterOk = false;
    console.log(`  mismatch at byte ${cut}`);
    break;
  }
}
check("splitter reproduces every element across all chunk boundaries", splitterOk, `${encoded.length - 1} split points`);

// Streaming through gunzip in tiny chunks, exactly as a shard is read.
const gz = gzipSync(encoded);
async function* tinyChunks(buffer, size) {
  for (let i = 0; i < buffer.length; i += size) yield buffer.subarray(i, i + size);
}
const { createGunzip } = await import("node:zlib");
const { Readable } = await import("node:stream");
const gunzip = createGunzip();
Readable.from(tinyChunks(gz, 7)).pipe(gunzip);
const streamed = [];
for await (const element of iterateJsonArray(gunzip)) streamed.push(element);
check(
  "iterateJsonArray yields every row from a gzip stream fed 7 bytes at a time",
  JSON.stringify(streamed) === JSON.stringify(rows),
  `${streamed.length} rows`,
);

// Pretty-printed arrays and scalar elements parse too.
const pretty = new JsonArraySplitter();
const prettyOut = [
  ...pretty.push('[\n  {"a": 1},\n  "text", 42, true, null,\n  [1, [2]]\n]'),
  ...pretty.finish(),
];
check(
  "splitter handles whitespace, scalars and nested arrays",
  JSON.stringify(prettyOut) === JSON.stringify([{ a: 1 }, "text", 42, true, null, [1, [2]]]),
  JSON.stringify(prettyOut),
);

let threw = false;
try {
  const bad = new JsonArraySplitter();
  bad.push('[{"a":1},{"b":');
  bad.finish();
} catch {
  threw = true;
}
check("splitter reports a truncated shard instead of silently dropping the tail", threw);

/* ---------------- bounded selection ---------------- */

const newest = new BoundedSelection(2, "newest");
for (const [id, date] of [["x", "2024-01-05"], ["y", null], ["z", "2024-03-01"], ["w", "2023-12-31"]]) {
  newest.push({ id }, date);
}
check(
  "BoundedSelection(newest) keeps the two latest dates and ranks undated rows last",
  JSON.stringify(newest.rows().map((r) => r.id)) === JSON.stringify(["z", "x"]),
  JSON.stringify(newest.rows().map((r) => r.id)),
);
const oldest = new BoundedSelection(3, "oldest");
for (const [id, date] of [["x", "2024-01-05"], ["y", null], ["z", "2024-03-01"], ["w", "2023-12-31"]]) {
  oldest.push({ id }, date);
}
check(
  "BoundedSelection(oldest) orders ascending with undated rows last",
  JSON.stringify(oldest.rows().map((r) => r.id)) === JSON.stringify(["w", "x", "z"]),
  JSON.stringify(oldest.rows().map((r) => r.id)),
);

/* ---------------- coverage merge ---------------- */

const manifest = {
  generatedAt: "2026-09-03T00:00:00Z",
  schemaVersion: 2,
  sources: {},
  datasets: {
    "insider-transactions": {
      title: "Insider transactions",
      exportDir: "insider/transactions",
      rows: 10,
      lastIngestedAt: null,
      stale: false,
      snapshots: [
        { file: "snapshot-2025.json.gz", rows: 3 },
        { file: "snapshot-2026.json.gz", rows: 7 },
        { file: "snapshot-2047.json.gz", rows: 1 },
        { file: "snapshot-0012.json.gz", rows: 1 },
        { file: "snapshot-2020.json.gz", rows: 0 },
        { file: "snapshot.json.gz", rows: 10 },
      ],
      feed: null,
    },
  },
};
const archives = {
  generatedAt: "2026-09-03T00:00:00Z",
  repository: "LuxAlgo/market-trackers-data",
  releases: [],
  datasets: {
    "insider-transactions": {
      years: {
        2006: { tag: "archive-edgar-bulk-2006-01-01-2026-08-31", asset: "snapshot-2006.json.gz", bytes: 29_000_000, updatedAt: "2026-08-31T02:36:00Z" },
        2025: { tag: "archive-edgar-bulk-2006-01-01-2026-08-31", asset: "snapshot-2025.json.gz", bytes: 35_000_000, updatedAt: "2026-08-31T02:36:00Z" },
        2034: { tag: "archive-edgar-bulk-2006-01-01-2026-08-31", asset: "snapshot-2034.json.gz", bytes: 600, updatedAt: "2026-08-31T02:36:00Z" },
      },
    },
  },
};
const now = new Date("2026-09-03T00:00:00Z");
const coverage = coverageFor("insider-transactions", manifest, archives, now);
check(
  "coverageFor merges live and archive years and drops stray/empty shards",
  JSON.stringify(coverage.map((c) => [c.year, !!c.live, !!c.archive])) ===
    JSON.stringify([
      [2006, false, true],
      [2025, true, true],
      [2026, true, false],
    ]),
  JSON.stringify(coverage.map((c) => c.year)),
);
check("isSaneYear accepts next year and rejects stray event years", isSaneYear(2027, now) && !isSaneYear(2047, now) && !isSaneYear(12, now));
check(
  "yearRanges renders compact ranges",
  yearRanges([1999, 2000, 2001, 2003, 2006, 2007]) === "1999–2001, 2003, 2006–2007",
  yearRanges([1999, 2000, 2001, 2003, 2006, 2007]),
);

/* ---------------- filters ---------------- */

check(
  "matchesDateRange treats YYYY / YYYY-MM prefixes inclusively",
  matchesDateRange("2024-03-15", "2024", "2024") &&
    matchesDateRange("2024-03-15", "2024-03", "2024-03") &&
    !matchesDateRange("2024-03-15", "2024-04") &&
    !matchesDateRange("2024-03-15", undefined, "2024-02") &&
    !matchesDateRange(null, "2024") &&
    matchesDateRange(null),
);
const hearing = { committees: [{ name: "Banking" }, { name: "Finance" }], witnesses: ["Jane Doe"], member: { state: "ca" } };
check(
  "valuesAt flattens arrays of objects and matchesWhere is case-insensitive",
  JSON.stringify(valuesAt(hearing, "committees.name")) === JSON.stringify(["Banking", "Finance"]) &&
    matchesWhere(hearing, { "member.state": "CA" }) &&
    matchesWhere(hearing, { "committees.name": "finance" }) &&
    !matchesWhere(hearing, { "member.state": "NY" }),
);
check(
  "lobbying event date is the filing year; insider falls back to filedAt",
  TRACKER_DATASETS["lobbying-filings"].eventDate({ filingYear: 2019 }) === "2019-01-01" &&
    TRACKER_DATASETS["insider-transactions"].eventDate({ transactedAt: null, filedAt: "2024-02-02" }) === "2024-02-02",
);

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);

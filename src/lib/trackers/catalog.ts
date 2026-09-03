/*
  The Market Trackers catalog: one entry per dataset the LuxAlgo Market
  Trackers pipeline publishes as CC0 dumps (github.com/LuxAlgo/market-trackers-data).

  This mirrors the pipeline's dataset registry the way api.ts mirrors the app
  contract — shapes are redefined here, never imported, so this server has no
  dependency on the pipeline packages. The published manifest.json stays the
  source of truth for what exists and how fresh it is; this file only carries
  what a query engine needs to know about each row shape: the event date, the
  ticker and text fields, and the field roster agents compose filters from.
*/

export const TRACKER_DATASET_IDS = [
  "congress-trades",
  "insider-transactions",
  "thirteenf-holdings",
  "gov-contracts",
  "gov-grants",
  "lobbying-filings",
  "short-volume",
  "committee-assignments",
  "patents",
  "clinical-trials",
  "fda-approvals",
  "cot-reports",
  "wiki-pageviews",
  "bills",
  "fec-candidates",
  "fec-contributions",
  "congress-hearings",
  "fed-communications",
] as const;

export type TrackerDatasetId = (typeof TRACKER_DATASET_IDS)[number];

/** A published row. Every dataset carries `id` and `provenance.sourceUrl`. */
export type TrackerRow = Record<string, unknown>;

export interface TrackerDataset {
  id: TrackerDatasetId;
  title: string;
  description: string;
  /** Directory of this dataset inside the dumps repository. */
  exportDir: string;
  /** Primary sources, as named in the manifest's `sources` section. */
  sources: string[];
  /** The primary-source institution, for humans. */
  primarySource: string;
  /**
   * The row's event date (YYYY-MM-DD, or a YYYY[-MM] prefix); null when the
   * row has none. This is the date snapshots are sharded by, so a query for
   * year N reads shard N and the since/until filters compare against it.
   */
  eventDate: (row: TrackerRow) => string | null;
  /** Dot paths holding a ticker (string) or tickers (string[]). */
  tickerPaths: string[];
  /** Dot paths the case-insensitive `text` filter searches (arrays flatten). */
  textPaths: string[];
  /** Top-level field names of a published row, for composing `where` filters. */
  fields: string[];
  /**
   * Wholesale-replaced bulk data (no daily deltas, no latest.json): the year
   * shards are the whole export.
   */
  snapshotOnly?: boolean;
  caveats: string[];
}

/** Every value at a dot path; intermediate arrays flatten (`committees.name`). */
export function valuesAt(row: unknown, path: string): unknown[] {
  let current: unknown[] = [row];
  for (const segment of path.split(".")) {
    const next: unknown[] = [];
    for (const value of current) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item !== null && typeof item === "object") {
            next.push((item as Record<string, unknown>)[segment]);
          }
        }
      } else if (value !== null && typeof value === "object") {
        next.push((value as Record<string, unknown>)[segment]);
      }
    }
    current = next;
  }
  const out: unknown[] = [];
  for (const value of current) {
    if (Array.isArray(value)) out.push(...value);
    else if (value !== undefined) out.push(value);
  }
  return out;
}

function str(row: TrackerRow, path: string): string | null {
  const [value] = valuesAt(row, path);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function yearOf(row: TrackerRow, path: string): string | null {
  const [value] = valuesAt(row, path);
  return typeof value === "number" && Number.isFinite(value) ? `${value}-01-01` : null;
}

const PROVENANCE_FIELD = "provenance";
const BEST_EFFORT_TICKERS =
  "tickers are a best-effort mapping against a curated map of public companies; an empty tickers array means unmapped, not private";

export const TRACKER_DATASETS: Record<TrackerDatasetId, TrackerDataset> = {
  "congress-trades": {
    id: "congress-trades",
    title: "Congressional trades",
    description:
      "Transactions from congressional Periodic Transaction Reports (Senate eFD and House Clerk), one row per reported transaction, amounts kept as the disclosed ranges.",
    exportDir: "congress/trades",
    sources: ["senate-efd", "house-clerk"],
    primarySource: "Senate eFD and the House Clerk",
    eventDate: (row) => str(row, "transactedAt"),
    tickerPaths: ["ticker"],
    textPaths: ["member.name", "member.bioguideId", "member.state", "assetDescription"],
    fields: [
      "id",
      "chamber",
      "docId",
      "rowIndex",
      "member",
      "filedAt",
      "transactedAt",
      "ticker",
      "assetDescription",
      "side",
      "amountRange",
      "owner",
      PROVENANCE_FIELD,
    ],
    caveats: [
      "amountRange is the disclosed range (min, max, text) — never a point estimate",
      "ticker is null when the report did not name a trading symbol",
    ],
  },
  "insider-transactions": {
    id: "insider-transactions",
    title: "Insider transactions",
    description:
      "SEC Forms 3/4/5 ownership filings, one row per transaction or initial holding: issuer, insider and role, transaction code, shares, price, post-transaction holdings.",
    exportDir: "insider/transactions",
    sources: ["edgar", "edgar-bulk"],
    primarySource: "SEC EDGAR",
    eventDate: (row) => str(row, "transactedAt") ?? str(row, "filedAt"),
    tickerPaths: ["ticker"],
    textPaths: ["issuerName", "insider.name", "insider.title", "accessionNumber"],
    fields: [
      "id",
      "accessionNumber",
      "formType",
      "ticker",
      "issuerCik",
      "issuerName",
      "insider",
      "transactedAt",
      "filedAt",
      "code",
      "acquiredDisposed",
      "securityTitle",
      "shares",
      "pricePerShare",
      "sharesOwnedAfter",
      "ownership",
      "isDerivative",
      PROVENANCE_FIELD,
    ],
    caveats: [
      "code is the SEC transaction code (P purchase, S sale, A grant, M option exercise, F tax withholding, G gift, …)",
      "ticker is null when the filing carries no trading symbol",
    ],
  },
  "thirteenf-holdings": {
    id: "thirteenf-holdings",
    title: "13F holdings",
    description:
      "Quarterly institutional holdings from EDGAR 13F-HR information tables, CUSIP-keyed with best-effort ticker resolution.",
    exportDir: "thirteenf/holdings",
    sources: ["edgar"],
    primarySource: "SEC EDGAR",
    eventDate: (row) => str(row, "periodEnd"),
    tickerPaths: ["ticker"],
    textPaths: ["managerName", "issuerName", "cusip", "managerCik"],
    fields: [
      "id",
      "accessionNumber",
      "managerCik",
      "managerName",
      "periodEnd",
      "filedAt",
      "cusip",
      "ticker",
      "issuerName",
      "shareType",
      "shares",
      "valueUsd",
      "putCall",
      PROVENANCE_FIELD,
    ],
    caveats: ["periodEnd is the quarter the holdings describe; filedAt is when the manager filed"],
  },
  "gov-contracts": {
    id: "gov-contracts",
    title: "Government contract awards",
    description:
      "Federal contract awards from USAspending with best-effort recipient→ticker mapping against a curated map of public-company subsidiaries.",
    exportDir: "contracts/awards",
    sources: ["usaspending"],
    primarySource: "USAspending.gov",
    eventDate: (row) => str(row, "actionDate"),
    tickerPaths: ["recipient.tickers"],
    textPaths: ["recipient.name", "agency", "subAgency", "description", "naicsDescription"],
    fields: [
      "id",
      "awardId",
      "awardType",
      "agency",
      "subAgency",
      "recipient",
      "amountUsd",
      "actionDate",
      "description",
      "naicsCode",
      "naicsDescription",
      PROVENANCE_FIELD,
    ],
    caveats: [BEST_EFFORT_TICKERS],
  },
  "gov-grants": {
    id: "gov-grants",
    title: "Government grant awards",
    description:
      "Federal grant awards from USAspending (grant award types), same record shape and recipient→ticker mapping as contracts.",
    exportDir: "grants/awards",
    sources: ["usaspending"],
    primarySource: "USAspending.gov",
    eventDate: (row) => str(row, "actionDate"),
    tickerPaths: ["recipient.tickers"],
    textPaths: ["recipient.name", "agency", "subAgency", "description", "naicsDescription"],
    fields: [
      "id",
      "awardId",
      "awardType",
      "agency",
      "subAgency",
      "recipient",
      "amountUsd",
      "actionDate",
      "description",
      "naicsCode",
      "naicsDescription",
      PROVENANCE_FIELD,
    ],
    caveats: [BEST_EFFORT_TICKERS],
  },
  "lobbying-filings": {
    id: "lobbying-filings",
    title: "Lobbying filings",
    description:
      "Lobbying disclosure filings from the Senate LDA API: registrant, client, reported amount, filing period, issue areas, and the bills referenced, with best-effort client→ticker mapping.",
    exportDir: "lobbying/filings",
    sources: ["lda"],
    primarySource: "US Senate Lobbying Disclosure Act database",
    eventDate: (row) => yearOf(row, "filingYear"),
    tickerPaths: ["client.tickers"],
    textPaths: ["registrant.name", "client.name", "issues", "billReferences", "filingPeriod"],
    fields: [
      "id",
      "filingUuid",
      "registrant",
      "client",
      "amountUsd",
      "filingYear",
      "filingPeriod",
      "filingType",
      "issues",
      "billReferences",
      PROVENANCE_FIELD,
    ],
    caveats: [
      "the event date is the filing year only (filings are quarterly); since/until work at year granularity here",
      BEST_EFFORT_TICKERS,
    ],
  },
  "short-volume": {
    id: "short-volume",
    title: "Short-sale volume",
    description:
      "FINRA Reg SHO daily short-sale volume, one row per symbol-day-market: short, short-exempt and total volume, and the short ratio.",
    exportDir: "short-volume/daily",
    sources: ["finra"],
    primarySource: "FINRA",
    eventDate: (row) => str(row, "date"),
    tickerPaths: ["ticker"],
    textPaths: ["market"],
    fields: [
      "id",
      "date",
      "ticker",
      "market",
      "shortVolume",
      "shortExemptVolume",
      "totalVolume",
      "shortRatio",
      PROVENANCE_FIELD,
    ],
    caveats: [
      "daily short-sale volume is not short interest: it counts shares sold short that day on the reporting venue, not open short positions",
    ],
  },
  "committee-assignments": {
    id: "committee-assignments",
    title: "Congressional committee assignments",
    description:
      "Current member↔committee/subcommittee assignments from the public-domain unitedstates/congress-legislators dataset — the join between who trades and what their committee oversees.",
    exportDir: "congress/committees",
    sources: ["congress-legislators"],
    primarySource: "unitedstates/congress-legislators (public domain)",
    eventDate: (row) => str(row, "provenance.retrievedAt")?.slice(0, 10) ?? null,
    tickerPaths: [],
    textPaths: ["memberName", "bioguideId", "committee.name", "committee.thomasId", "title"],
    fields: [
      "id",
      "bioguideId",
      "memberName",
      "chamber",
      "committee",
      "rank",
      "title",
      PROVENANCE_FIELD,
    ],
    caveats: [
      "a current-state snapshot: rows describe today's assignments, and the event date is the retrieval date",
    ],
  },
  patents: {
    id: "patents",
    title: "Granted patents",
    description:
      "US patents granted since 1976, from PatentsView bulk grant data on the USPTO Open Data Portal, with best-effort assignee→ticker mapping.",
    exportDir: "patents/grants",
    sources: ["patentsview"],
    primarySource: "USPTO (PatentsView)",
    eventDate: (row) => str(row, "grantDate"),
    tickerPaths: ["assignee.tickers"],
    textPaths: ["title", "assignee.name", "cpcClass", "patentId"],
    fields: [
      "id",
      "patentId",
      "title",
      "grantDate",
      "assignee",
      "assigneeCount",
      "kind",
      "cpcClass",
      PROVENANCE_FIELD,
    ],
    snapshotOnly: true,
    caveats: [
      "quarterly wholesale bulk data: no daily deltas or latest.json, only year shards",
      BEST_EFFORT_TICKERS,
    ],
  },
  "clinical-trials": {
    id: "clinical-trials",
    title: "Clinical trial registrations",
    description:
      "Study registrations and status changes from ClinicalTrials.gov: sponsor, phase, status, conditions, last update — sponsor-declared registry facts with best-effort sponsor→ticker mapping.",
    exportDir: "clinical-trials/studies",
    sources: ["clinicaltrials"],
    primarySource: "ClinicalTrials.gov",
    eventDate: (row) => str(row, "lastUpdated"),
    tickerPaths: ["sponsor.tickers"],
    textPaths: ["title", "sponsor.name", "conditions", "nctId", "phase", "overallStatus"],
    fields: [
      "id",
      "nctId",
      "title",
      "sponsor",
      "phase",
      "overallStatus",
      "studyType",
      "conditions",
      "lastUpdated",
      PROVENANCE_FIELD,
    ],
    caveats: ["the event date is the registry's last-update date, not the study start", BEST_EFFORT_TICKERS],
  },
  "fda-approvals": {
    id: "fda-approvals",
    title: "FDA drug application events",
    description:
      "Drug-application submission events (originals and supplements) with FDA status codes and dates, from openFDA's Drugs@FDA endpoint, with best-effort sponsor→ticker mapping.",
    exportDir: "fda/approvals",
    sources: ["openfda"],
    primarySource: "FDA (openFDA Drugs@FDA)",
    eventDate: (row) => str(row, "statusDate"),
    tickerPaths: ["sponsor.tickers"],
    textPaths: ["sponsor.name", "brandName", "applicationNumber", "submissionType", "submissionStatus"],
    fields: [
      "id",
      "applicationNumber",
      "sponsor",
      "brandName",
      "submissionType",
      "submissionNumber",
      "submissionStatus",
      "statusDate",
      PROVENANCE_FIELD,
    ],
    caveats: [BEST_EFFORT_TICKERS],
  },
  "cot-reports": {
    id: "cot-reports",
    title: "CFTC Commitments of Traders",
    description:
      "Weekly Commitments of Traders positioning (legacy futures-only) per contract market: open interest and commercial, non-commercial and non-reportable long/short positions.",
    exportDir: "cot/legacy-futures",
    sources: ["cftc"],
    primarySource: "CFTC",
    eventDate: (row) => str(row, "reportDate"),
    tickerPaths: [],
    textPaths: ["marketName", "contractCode"],
    fields: [
      "id",
      "reportDate",
      "contractCode",
      "marketName",
      "openInterest",
      "commercialLong",
      "commercialShort",
      "nonCommercialLong",
      "nonCommercialShort",
      "nonReportableLong",
      "nonReportableShort",
      PROVENANCE_FIELD,
    ],
    caveats: ["positions are contracts as reported by the CFTC, legacy futures-only format"],
  },
  "wiki-pageviews": {
    id: "wiki-pageviews",
    title: "Wikipedia pageviews",
    description:
      "Daily per-article Wikipedia pageview counts for a curated map of public-company articles, from the Wikimedia REST pageviews API.",
    exportDir: "wiki/pageviews",
    sources: ["wikimedia"],
    primarySource: "Wikimedia",
    eventDate: (row) => str(row, "day"),
    tickerPaths: ["tickers"],
    textPaths: ["article", "project"],
    fields: ["id", "project", "article", "day", "views", "tickers", PROVENANCE_FIELD],
    caveats: ["only articles in the curated company map are tracked"],
  },
  bills: {
    id: "bills",
    title: "Federal legislation",
    description:
      "Bill status records from GPO GovInfo's BILLSTATUS data: titles, sponsors, latest actions, and policy areas, verbatim from the record.",
    exportDir: "congress/bills",
    sources: ["govinfo"],
    primarySource: "GPO GovInfo",
    eventDate: (row) => str(row, "latestActionDate") ?? str(row, "introducedDate"),
    tickerPaths: [],
    textPaths: ["title", "sponsorName", "sponsorBioguideId", "policyArea", "latestActionText"],
    fields: [
      "id",
      "congress",
      "billType",
      "billNumber",
      "title",
      "introducedDate",
      "latestActionDate",
      "latestActionText",
      "sponsorBioguideId",
      "sponsorName",
      "policyArea",
      "cosponsorCount",
      PROVENANCE_FIELD,
    ],
    caveats: ["the event date is the latest action date, falling back to the introduction date"],
  },
  "fec-candidates": {
    id: "fec-candidates",
    title: "FEC candidate totals",
    description:
      "Candidate-cycle campaign-finance summaries (receipts, disbursements, cash on hand) from the FEC's bulk downloads.",
    exportDir: "fec/candidates",
    sources: ["fec"],
    primarySource: "FEC",
    eventDate: (row) => str(row, "coverageEndDate") ?? yearOf(row, "cycle"),
    tickerPaths: [],
    textPaths: ["name", "candidateId", "party", "state", "district"],
    fields: [
      "id",
      "candidateId",
      "cycle",
      "name",
      "party",
      "office",
      "state",
      "district",
      "incumbentChallenger",
      "totalReceipts",
      "totalDisbursements",
      "cashOnHand",
      PROVENANCE_FIELD,
    ],
    caveats: ["office is H (House), S (Senate) or P (President)"],
  },
  "fec-contributions": {
    id: "fec-contributions",
    title: "FEC committee→candidate contributions",
    description:
      "Committee-to-candidate contributions from the FEC's bulk downloads, amounts verbatim as filed.",
    exportDir: "fec/contributions",
    sources: ["fec"],
    primarySource: "FEC",
    eventDate: (row) => str(row, "date") ?? yearOf(row, "cycle"),
    tickerPaths: [],
    textPaths: ["committeeName", "candidateName", "committeeId", "candidateId", "transactionType"],
    fields: [
      "id",
      "committeeId",
      "committeeName",
      "candidateId",
      "candidateName",
      "amountUsd",
      "date",
      "transactionType",
      "cycle",
      PROVENANCE_FIELD,
    ],
    caveats: ["amounts are as filed; refunds are negative"],
  },
  "congress-hearings": {
    id: "congress-hearings",
    title: "Congressional hearing transcripts",
    description:
      "Published hearing transcript packages from GPO GovInfo's CHRG collection: title, committees, witnesses, member bioguide ids, and deep links to the transcript. An index with receipts; the text stays at govinfo.",
    exportDir: "congress/hearings",
    sources: ["govinfo-hearings"],
    primarySource: "GPO GovInfo",
    eventDate: (row) => str(row, "heldDate"),
    tickerPaths: [],
    textPaths: ["title", "committees.name", "witnesses", "memberBioguideIds", "citation"],
    fields: [
      "id",
      "packageId",
      "title",
      "chamber",
      "docClass",
      "congress",
      "session",
      "heldDate",
      "citation",
      "committees",
      "witnesses",
      "memberBioguideIds",
      "detailUrl",
      "htmlUrl",
      "pdfUrl",
      PROVENANCE_FIELD,
    ],
    caveats: ["GPO publishes transcripts weeks to months after a hearing is held"],
  },
  "fed-communications": {
    id: "fed-communications",
    title: "Federal Reserve communications",
    description:
      "Federal Reserve Board monetary-policy communications: FOMC statements and minutes announcements, speeches, and testimony — titles, speakers, dates, and deep links, verbatim.",
    exportDir: "fed/communications",
    sources: ["federalreserve"],
    primarySource: "Federal Reserve Board",
    eventDate: (row) => str(row, "date"),
    tickerPaths: [],
    textPaths: ["title", "speaker", "venue", "type"],
    fields: ["id", "type", "date", "title", "speaker", "venue", "url", "videoUrl", "note", PROVENANCE_FIELD],
    caveats: [],
  },
};

export const TRACKER_DATASET_LIST: TrackerDataset[] = TRACKER_DATASET_IDS.map(
  (id) => TRACKER_DATASETS[id],
);

/** Datasets a ticker overview fans out across (every dataset with a ticker field). */
export const TICKER_DATASETS: TrackerDatasetId[] = TRACKER_DATASET_LIST.filter(
  (dataset) => dataset.tickerPaths.length > 0,
).map((dataset) => dataset.id);

export function isTrackerDatasetId(value: string): value is TrackerDatasetId {
  return (TRACKER_DATASET_IDS as readonly string[]).includes(value);
}

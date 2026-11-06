/*
  The Library endpoints of the app API — indicators, concepts, families,
  Pine source — plus the concept taxonomy the tools validate against.

  Cached in-process because they are identical for every caller: the
  concepts list, indicator queries (the app's public query route never looks
  at who is asking, so it is fetched anonymously) and the marketing site's
  markdown pages (never fetched with a token). Indicator pages by slug are
  fetched per call with the caller's token: the app decides how much source
  a signed-out caller sees.
*/
import { appGet, cachedAnonymous, fetchMarkdown, isNotFound } from "../../platform/app-client.js";
import { hedged, keyedCache } from "../_shared/cache.js";

export const CONCEPT_FAMILIES = [
  "trend",
  "momentum",
  "volatility",
  "volume-orderflow",
  "market-structure",
  "smc-ict",
  "wyckoff",
  "elliott-harmonics",
  "patterns",
  "levels",
  "statistics",
  "machine-learning",
  "time-seasonality",
  "sentiment-breadth",
  "risk-exits",
  "meta-composition",
  "validation",
] as const;
export type ConceptFamily = (typeof CONCEPT_FAMILIES)[number];

export const FAMILY_NAMES: Record<ConceptFamily, string> = {
  trend: "Trend",
  momentum: "Momentum",
  volatility: "Volatility",
  "volume-orderflow": "Volume & Flow",
  "market-structure": "Structure",
  "smc-ict": "SMC / ICT",
  wyckoff: "Wyckoff",
  "elliott-harmonics": "Elliott & Harmonics",
  patterns: "Patterns",
  levels: "Levels",
  statistics: "Statistics",
  "machine-learning": "Machine Learning",
  "time-seasonality": "Time & Seasonality",
  "sentiment-breadth": "Sentiment & Breadth",
  "risk-exits": "Risk & Exits",
  "meta-composition": "Meta & Composition",
  validation: "Validation",
};

export type Concept = {
  id: string;
  slug: string;
  name: string;
  family: ConceptFamily;
  cluster: string | null;
  aliases: string[];
  isFringe: boolean;
};

export type IndicatorSummary = {
  id: string;
  name: string | null;
  slug: string;
  imageUrl: string | null;
  description: string | null;
  body: string | null;
  authorName: string | null;
  creationDateDisplayed: string;
  family: ConceptFamily | null;
  pineScriptCodeId: string | null;
};

export type IndicatorDetail = IndicatorSummary & {
  /** Additive field requested on the by-slug endpoint (see the audit doc);
   *  passed through when the API serves it, omitted until then. */
  concepts?: { slug: string; name: string; primary: boolean }[];
} & Record<string, unknown>;

const CACHE_TTL_MS = 5 * 60 * 1000;

export const getConcepts = cachedAnonymous(CACHE_TTL_MS, async () => {
  const { concepts } = await hedged(() =>
    appGet<{ concepts: Concept[] }>("/api/library/concepts", undefined, { access: null }),
  );
  return concepts;
});

const indicatorQueries = keyedCache<{ indicators: IndicatorSummary[]; count: number }>({
  ttlMs: CACHE_TTL_MS,
  max: 200,
});

const markdownPages = keyedCache<string | null>({ ttlMs: 10 * 60 * 1000, max: 300 });

/** A marketing-site markdown page (no token is ever sent there), cached; null on 404. */
export function getMarkdown(path: string): Promise<string | null> {
  return markdownPages.get(path, () => hedged(() => fetchMarkdown(path)));
}

export async function queryIndicators(params: {
  text?: string;
  family?: ConceptFamily;
  /** Concept slug — only indicators linked to this genome concept. */
  concept?: string;
  platform?: string;
  tier?: string;
  authorName?: string;
  sort?: "name" | "creationDateDisplayed" | "family";
  direction?: "asc" | "desc";
  pageIndex?: number;
  pageQuantity?: number;
}): Promise<{ indicators: IndicatorSummary[]; count: number }> {
  const query = {
    text: params.text,
    family: params.family,
    concept: params.concept,
    platform: params.platform,
    tier: params.tier,
    authorName: params.authorName,
    sort: params.sort,
    direction: params.direction,
    pageIndex: params.pageIndex !== undefined ? String(params.pageIndex) : undefined,
    pageQuantity: params.pageQuantity !== undefined ? String(params.pageQuantity) : undefined,
    // Card rows leave out the long article body, which no list result uses.
    fields: "card",
  };
  // One app instance in two takes 4-6 s on this route: up to four parallel
  // tries, 600 ms apart, so a slow instance rarely decides the answer time.
  return indicatorQueries.get(JSON.stringify(query), () =>
    hedged(
      () =>
        appGet<{ indicators: IndicatorSummary[]; count: number }>("/api/library/indicators/query", query, {
          access: null,
        }),
      { afterMs: 600, attempts: 4 },
    ),
  );
}

export async function getIndicatorBySlug(
  slug: string,
): Promise<{
  indicator: IndicatorDetail;
  pineScriptCode: string | null;
  /** Set by the app when `pineScriptCode` is only the start of the source. */
  sourcePreview?: { shownLines: number; totalLines: number } | null;
} | null> {
  try {
    return await appGet(`/api/library/indicators/by-slug/${encodeURIComponent(slug)}`);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Pine source by id from the keyless pinescript route (the same surface the
 * "Use in Quant" handoff reads). Fallback for when by-slug withholds the
 * inline source; null when the id serves nothing.
 */
export async function getPineScriptCode(pineScriptCodeId: string): Promise<string | null> {
  try {
    const { code } = await appGet<{ code: string }>(`/api/library/pinescript/${encodeURIComponent(pineScriptCodeId)}`);
    return code;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

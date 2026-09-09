/*
  The Library endpoints of the app API — indicators, concepts, families,
  tags, Pine source — plus the concept taxonomy the tools validate against.
  The concepts and tags lists are cached in-process (small, rarely changing,
  identical for every caller); everything else is fetched per call.
*/
import { appGet, cachedAnonymous, isNotFound } from "../../platform/app-client.js";

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
  /** Tag ids/names served by the query route; absent on by-slug payloads. */
  tags?: { id: string; name: string }[];
};

export type IndicatorDetail = IndicatorSummary & {
  /** Additive field requested on the by-slug endpoint (see the audit doc);
   *  passed through when the API serves it, omitted until then. */
  concepts?: { slug: string; name: string; primary: boolean }[];
} & Record<string, unknown>;

export type LibraryTag = { id: string; name: string; order: number | null };

const CACHE_TTL_MS = 5 * 60 * 1000;

export const getConcepts = cachedAnonymous(CACHE_TTL_MS, async () => {
  const { concepts } = await appGet<{ concepts: Concept[] }>("/api/library/concepts", undefined, { access: null });
  return concepts;
});

export const getLibraryTags = cachedAnonymous(CACHE_TTL_MS, async () => {
  const { tags } = await appGet<{ tags: LibraryTag[] }>("/api/library/tags", undefined, { access: null });
  return tags;
});

export async function queryIndicators(params: {
  text?: string;
  family?: ConceptFamily;
  /** Concept slug — only indicators linked to this genome concept. */
  concept?: string;
  /** Tag ids (AND-combined server-side), sent as a CSV. */
  tags?: string[];
  platform?: string;
  tier?: string;
  authorName?: string;
  sort?: "name" | "creationDateDisplayed" | "family";
  direction?: "asc" | "desc";
  pageIndex?: number;
  pageQuantity?: number;
}): Promise<{ indicators: IndicatorSummary[]; count: number }> {
  return appGet("/api/library/indicators/query", {
    text: params.text,
    family: params.family,
    concept: params.concept,
    tags: params.tags && params.tags.length > 0 ? params.tags.join(",") : undefined,
    platform: params.platform,
    tier: params.tier,
    authorName: params.authorName,
    sort: params.sort,
    direction: params.direction,
    pageIndex: params.pageIndex !== undefined ? String(params.pageIndex) : undefined,
    pageQuantity: params.pageQuantity !== undefined ? String(params.pageQuantity) : undefined,
  });
}

export async function getIndicatorBySlug(
  slug: string,
): Promise<{ indicator: IndicatorDetail; pineScriptCode: string | null } | null> {
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

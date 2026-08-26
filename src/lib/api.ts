/*
  Thin clients for the public LuxAlgo surfaces the MCP server reads:

  - the app API (JSON, `{data, errors}` envelope) for structured data —
    library indicators, concepts, and families, plus the prop-firm
    catalog (firms, challenges, offers);
  - the marketing site's plain-markdown routes for long-form content —
    every concept and family page is also served as `.md`.

  Everything is keyless and read-only. The concepts list is cached
  in-process (it is small and changes rarely); everything else is
  fetched per call.
*/

export const APP_API_ORIGIN =
  process.env.LUXALGO_APP_ORIGIN ?? "https://app.luxalgo.com";
export const SITE_ORIGIN =
  process.env.LUXALGO_SITE_ORIGIN ?? "https://www.luxalgo.com";

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

class AppApiError extends Error {}

async function appGet<T>(pathname: string, query?: Record<string, string | undefined>): Promise<T> {
  const url = new URL(pathname, APP_API_ORIGIN);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new AppApiError(`LuxAlgo API ${response.status} for ${pathname}`);
  }
  const payload = (await response.json()) as { data?: T; errors?: { message: string }[] };
  if (payload.errors?.length) throw new AppApiError(payload.errors[0]!.message);
  if (payload.data === undefined) throw new AppApiError(`Empty response for ${pathname}`);
  return payload.data;
}

/** Plain-markdown page from the marketing site; null on 404. */
export async function fetchMarkdown(path: string): Promise<string | null> {
  const response = await fetch(new URL(path, SITE_ORIGIN), {
    headers: { accept: "text/markdown, text/plain" },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new AppApiError(`LuxAlgo site ${response.status} for ${path}`);
  return await response.text();
}

let conceptsCache: { at: number; concepts: Concept[] } | null = null;
const CONCEPTS_TTL_MS = 5 * 60 * 1000;

export async function getConcepts(): Promise<Concept[]> {
  if (conceptsCache && Date.now() - conceptsCache.at < CONCEPTS_TTL_MS) {
    return conceptsCache.concepts;
  }
  const { concepts } = await appGet<{ concepts: Concept[] }>("/api/library/concepts");
  conceptsCache = { at: Date.now(), concepts };
  return concepts;
}

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

export type LibraryTag = { id: string; name: string; order: number | null };

let tagsCache: { at: number; tags: LibraryTag[] } | null = null;
const TAGS_TTL_MS = 5 * 60 * 1000;

export async function getLibraryTags(): Promise<LibraryTag[]> {
  if (tagsCache && Date.now() - tagsCache.at < TAGS_TTL_MS) return tagsCache.tags;
  const { tags } = await appGet<{ tags: LibraryTag[] }>("/api/library/tags");
  tagsCache = { at: Date.now(), tags };
  return tags;
}

export async function getIndicatorBySlug(
  slug: string,
): Promise<{ indicator: IndicatorDetail; pineScriptCode: string | null } | null> {
  try {
    return await appGet(`/api/library/indicators/by-slug/${encodeURIComponent(slug)}`);
  } catch (error) {
    if (error instanceof AppApiError && /404|not found/i.test(error.message)) return null;
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
    const { code } = await appGet<{ code: string }>(
      `/api/library/pinescript/${encodeURIComponent(pineScriptCodeId)}`,
    );
    return code;
  } catch (error) {
    if (error instanceof AppApiError && /404|not found/i.test(error.message)) return null;
    throw error;
  }
}

/*
  Prop-firm analysis — the three public query routes. Each takes composable
  filters as query-string params (numbers/booleans/CSVs already stringified
  by the tool layer) and returns `{ <rows>, count }`. Hidden firms never
  appear; offers default to live (active, unexpired) ones.
*/

export type PropfirmOffer = {
  offerId: string;
  firmId: string;
  propfirmId: string;
  propfirmName: string;
  promoCode: string | null;
  affiliateLink: string | null;
  discountIsPercent: boolean;
  discountValue: number | null;
  shortDescription: string | null;
  fullDescription: string | null;
  isActive: boolean;
  isFeatured: boolean;
  hasEndDate: boolean;
  endsAt: string | null;
  scope: { type: "all_challenges" } | { type: "specific_challenges"; challengeIds: string[] };
};

export type PropfirmChallenge = {
  challengeId: string;
  challengeName: string;
  accountSize: number;
  steps: number;
  price: number | null;
  profitSplitPercent: number | null;
  firmId: string;
  propfirmId: string;
  propfirmName: string;
  offers?: PropfirmOffer[];
} & Record<string, unknown>;

export type PropfirmFirm = {
  id: string;
  propfirmId: string;
  name: string;
  yearFounded: number | null;
  isPreferredPartner: boolean;
  reviewsTrustPilotScore: number | null;
  reviewsTrustPilotCount: number | null;
  challenges?: PropfirmChallenge[];
  offers?: PropfirmOffer[];
  overview?: Record<string, unknown>;
} & Record<string, unknown>;

export type PropfirmQueryParams = Record<string, string | undefined>;

export async function queryPropfirms(
  params: PropfirmQueryParams,
): Promise<{ firms: PropfirmFirm[]; count: number }> {
  return appGet("/api/propfirms/query", params);
}

export async function queryPropfirmChallenges(
  params: PropfirmQueryParams,
): Promise<{ challenges: PropfirmChallenge[]; count: number }> {
  return appGet("/api/propfirms/challenges/query", params);
}

export async function queryPropfirmOffers(
  params: PropfirmQueryParams,
): Promise<{ offers: PropfirmOffer[]; count: number }> {
  return appGet("/api/propfirms/offers/query", params);
}

export const conceptUrl = (slug: string) => `${SITE_ORIGIN}/library/concept/${slug}/`;
export const conceptMdUrl = (slug: string) => `${SITE_ORIGIN}/library/concept/${slug}.md`;
export const familyUrl = (key: string) => `${SITE_ORIGIN}/library/family/${key}/`;
export const familyMdUrl = (key: string) => `${SITE_ORIGIN}/library/family/${key}.md`;
export const indicatorUrl = (slug: string) => `${SITE_ORIGIN}/library/indicator/${slug}/`;
export const quantUrl = (pineScriptCodeId: string) =>
  `${APP_API_ORIGIN}/quant?pineScriptCodeId=${encodeURIComponent(pineScriptCodeId)}`;

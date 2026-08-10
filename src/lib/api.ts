/*
  Thin clients for the two public LuxAlgo surfaces the MCP server reads:

  - the app API (JSON, `{data, errors}` envelope) for structured library
    data — indicators, concepts, families;
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
  authorName?: string;
  sort?: "name" | "creationDateDisplayed" | "family";
  direction?: "asc" | "desc";
  pageIndex?: number;
  pageQuantity?: number;
}): Promise<{ indicators: IndicatorSummary[]; count: number }> {
  return appGet("/api/library/indicators/query", {
    text: params.text,
    family: params.family,
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
    if (error instanceof AppApiError && /404|not found/i.test(error.message)) return null;
    throw error;
  }
}

export const conceptUrl = (slug: string) => `${SITE_ORIGIN}/library/concept/${slug}/`;
export const conceptMdUrl = (slug: string) => `${SITE_ORIGIN}/library/concept/${slug}.md`;
export const familyUrl = (key: string) => `${SITE_ORIGIN}/library/family/${key}/`;
export const familyMdUrl = (key: string) => `${SITE_ORIGIN}/library/family/${key}.md`;
export const indicatorUrl = (slug: string) => `${SITE_ORIGIN}/library/indicator/${slug}/`;
export const quantUrl = (pineScriptCodeId: string) =>
  `${APP_API_ORIGIN}/quant?pineScriptCodeId=${encodeURIComponent(pineScriptCodeId)}`;

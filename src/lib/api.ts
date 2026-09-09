/*
  Thin clients for the public LuxAlgo surfaces the MCP server reads:

  - the app API (JSON, `{data, errors}` envelope) for structured data —
    library indicators, concepts, and families, plus the prop-firm
    catalog (firms, challenges, offers);
  - the marketing site's plain-markdown routes for long-form content —
    every concept and family page is also served as `.md`.

  Everything here is read-only and works without credentials. When the caller
  has signed in with LuxAlgo, though, every app request carries their OAuth
  access token (see auth/access-context.ts): the app resolves the user from
  it exactly as from a browser session, and it — never this server — decides
  what that user may see. Its answers map to two typed errors: 401 → sign in
  (AppAuthError), 403 → the plan does not allow it (AppPermissionError).

  The concepts and tags lists are cached in-process (small, rarely changing,
  identical for every caller); everything else is fetched per call.
*/
import { currentAccess, type Access } from "./auth/access-context.js";

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

export class AppApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** The app wants a signed-in user for this and the request carried no valid token. */
export class AppAuthError extends AppApiError {
  constructor(pathname: string) {
    super(`LuxAlgo API needs a signed-in user for ${pathname}`, 401);
  }
}

/** The user is known but their plan (or role) does not allow this. */
export class AppPermissionError extends AppApiError {
  constructor(
    message: string,
    /** The failing permission key when the app named one (`details.permission`). */
    readonly permission: string | undefined,
  ) {
    super(message, 403);
  }
}

type ApiErrorBody = { message: string; details?: { permission?: unknown } };

export type AppGetOptions = {
  /**
   * Token to call the app with. Defaults to the ambient one for the current
   * tool call (auth/access-context.ts); pass `null` to call anonymously.
   */
  access?: Access | null;
};

export async function appGet<T>(
  pathname: string,
  query?: Record<string, string | undefined>,
  options: AppGetOptions = {},
): Promise<T> {
  const url = new URL(pathname, APP_API_ORIGIN);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  const access = options.access === undefined ? currentAccess() : options.access;
  const headers: Record<string, string> = { accept: "application/json" };
  if (access) headers.authorization = `Bearer ${access.token}`;

  const response = await fetch(url, { headers });
  const text = await response.text();
  let payload: { data?: T; errors?: ApiErrorBody[] } | undefined;
  try {
    payload = JSON.parse(text) as { data?: T; errors?: ApiErrorBody[] };
  } catch {
    payload = undefined;
  }
  const firstError = payload?.errors?.[0];

  if (response.status === 401) throw new AppAuthError(pathname);
  if (response.status === 403) {
    const permission = firstError?.details?.permission;
    throw new AppPermissionError(
      firstError?.message ?? `LuxAlgo API 403 for ${pathname}`,
      typeof permission === "string" ? permission : undefined,
    );
  }
  if (!response.ok) {
    throw new AppApiError(`LuxAlgo API ${response.status} for ${pathname}`, response.status);
  }
  if (payload === undefined) throw new AppApiError(`Non-JSON response for ${pathname}`, response.status);
  if (firstError) throw new AppApiError(firstError.message, response.status);
  if (payload.data === undefined) throw new AppApiError(`Empty response for ${pathname}`, response.status);
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
  // Shared across callers, so fetched anonymously — never a personalised view.
  const { concepts } = await appGet<{ concepts: Concept[] }>("/api/library/concepts", undefined, { access: null });
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
  const { tags } = await appGet<{ tags: LibraryTag[] }>("/api/library/tags", undefined, { access: null });
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

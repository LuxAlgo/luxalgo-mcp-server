/*
  The prop-firm directory tools — a faithful mapping of the three public
  query endpoints (/api/propfirms/query, /challenges/query, /offers/query)
  plus a one-firm convenience getter. All read-only and keyless. Tool
  params mirror the public API contract names exactly; arrays become CSV
  query params and numbers/booleans are stringified at the boundary.
  The simulation tools (propfirms_simulate & co.) live in simulation-tools.ts.
  One addition off the Claude address: a challenge text search that finds
  nothing is read as size + steps + firm (challenge-query.ts) and retried
  with the structured filters.
*/
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { currentSurface, type Toolset } from "../../auth/surface.js";
import { json, toolError } from "../_shared/result.js";
import { compact } from "../_shared/format.js";
import { SITE_ORIGIN } from "../../platform/app-client.js";
import {
  type PropfirmChallenge,
  type PropfirmFirm,
  type PropfirmOffer,
  queryPropfirmChallenges,
  queryPropfirmOffers,
  queryPropfirms,
} from "./api.js";
import {
  describeOfferedChallenges,
  type FirmRef,
  formatAccountSize,
  formatSteps,
  matchFirms,
  parseChallengeText,
} from "./challenge-query.js";

const MAX_LOSS_MODES = [
  "static-initial",
  "trailing-realized-eod",
  "trailing-intraday-unrealized",
] as const;

const FIRM_SORT_KEYS = [
  "name",
  "yearFounded",
  "reviewsTrustPilotScore",
  "reviewsTrustPilotCount",
] as const;
const CHALLENGE_SORT_KEYS = [
  "challengeName",
  "accountSize",
  "price",
  "steps",
  "profitSplitPercent",
] as const;
const OFFER_SORT_KEYS = ["discountValue", "endsAt", "promoCode"] as const;

/**
 * Tool args -> query-string params. Param names already match the API
 * contract, so this only handles representation: arrays join to CSV,
 * numbers and booleans stringify, undefined drops out.
 */
function toQuery(args: Record<string, unknown>): Record<string, string | undefined> {
  const query: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) query[key] = value.join(",");
    } else {
      query[key] = String(value);
    }
  }
  return query;
}

/*
  API rows carry ~20 always-null structured rule fields per challenge (the
  capture pipeline hasn't backfilled them yet). Null means "not captured",
  which reads the same as absence to an agent, so results go through
  compact() to drop null/undefined properties recursively.
*/

/**
 * The API duplicates each applicable offer verbatim onto every challenge
 * (a firm-wide offer appears once per challenge). Lift offers into one
 * deduplicated list and leave `offerIds` references on each challenge.
 */
function liftChallengeOffers(
  challenges: PropfirmChallenge[],
  seed: PropfirmOffer[] = [],
): { challenges: Record<string, unknown>[]; offers: PropfirmOffer[]; lifted: boolean } {
  const offerById = new Map(seed.map((offer) => [offer.offerId, offer]));
  let lifted = seed.length > 0;
  const rows = challenges.map((challenge) => {
    const { offers, ...rest } = challenge;
    if (!offers) return rest;
    lifted = true;
    for (const offer of offers) offerById.set(offer.offerId, offer);
    return { ...rest, offerIds: offers.map((offer) => offer.offerId) };
  });
  return { challenges: rows, offers: [...offerById.values()], lifted };
}

function liftFirmOffers(firm: PropfirmFirm): Record<string, unknown> {
  if (!firm.challenges) return firm;
  const { challenges, offers, lifted } = liftChallengeOffers(firm.challenges, firm.offers ?? []);
  return { ...firm, challenges, ...(lifted ? { offers } : {}) };
}

/*
  The "directory" toolset (auth/surface.ts) is the directory without offers:
  OpenAI's plugin rules and Claude's directory bar promoting discounts and promotions, and offers are
  promo codes and affiliate links. Offer filters, include values and the
  offers tool are left out, and offer payloads are stripped from results.
*/
function withoutOffers(firm: PropfirmFirm): Record<string, unknown> {
  const { offers: _offers, challenges, ...rest } = firm;
  if (!challenges) return rest;
  return { ...rest, challenges: challenges.map(({ offers: _o, ...challenge }) => challenge) };
}

/*
  propfirms_get off the Claude address (_shared/surface.ts): a firm's dossier
  without what a model does not need to answer from it. Each challenge
  repeats its firm's ids and name (already on the firm); the internal row id,
  logo and visibility flag are site plumbing; the overview's FAQ restates the
  rules and payout policy sections; bold markers are layout. Everything left
  out stays reachable: the FAQ through propfirms_search with include
  ['overview'].
*/
const FIRM_PLUMBING = ["id", "logoImageUrl", "isVisible"] as const;
const CHALLENGE_PARENT_FIELDS = ["firmId", "propfirmId", "propfirmName"] as const;

function withoutBold(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\*\*/g, "");
  if (Array.isArray(value)) return value.map(withoutBold);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, withoutBold(entry)]));
  }
  return value;
}

function trimDossier(firm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...firm };
  for (const key of FIRM_PLUMBING) delete out[key];
  if (Array.isArray(out.challenges)) {
    out.challenges = (out.challenges as Record<string, unknown>[]).map((challenge) => {
      const row = { ...challenge };
      for (const key of CHALLENGE_PARENT_FIELDS) delete row[key];
      return row;
    });
  }
  const omitted: string[] = [];
  if (out.overview !== null && typeof out.overview === "object") {
    const { faq, ...overview } = out.overview as Record<string, unknown>;
    out.overview = withoutBold(overview);
    if (faq !== undefined && faq !== null) {
      omitted.push(
        `overview.faq (it restates the rules and payout policy): propfirms_search with propfirmId ['${String(firm.propfirmId)}'] and include ['overview'] returns it`,
      );
    }
  }
  return {
    ...out,
    url: `${SITE_ORIGIN}/prop-firms/${encodeURIComponent(String(firm.propfirmId))}/`,
    ...(omitted.length > 0 ? { omitted } : {}),
  };
}

/**
 * Rule filters that silently drop challenges where the field is not
 * captured (null). When such a filter is active and the search comes back
 * empty, say so — zero results can mean missing data, not "no such
 * challenge" (maxLossMode in particular is sparsely captured).
 */
const NULL_DROPPING_CHALLENGE_FILTERS = [
  "maxLossMode",
  "newsTrading",
  "copyTrading",
  "autoTrading",
  "weekendHolding",
  "overnightHolding",
  "stoplossRequired",
  "isFeeRefundable",
  "profitSplitMin",
  "maxLeverageMin",
  "minTradingDaysMax",
  "dailyLossMax",
  "maxLossMax",
  "interval",
] as const;

function zeroResultWarnings(args: Record<string, unknown>): string[] | undefined {
  const active = NULL_DROPPING_CHALLENGE_FILTERS.filter((key) => args[key] !== undefined);
  if (active.length === 0) return undefined;
  return [
    `Zero results while rule filters were active (${active.join(", ")}). ` +
      "Challenges where a rule field is not captured (null) never match a filter on that field, " +
      "so an empty result can reflect missing data rather than no matching challenges. " +
      "Try dropping the sparsest filters (maxLossMode is uncaptured on most challenges) and " +
      "checking the free-text fields (e.g. maxLossType) on unfiltered results instead.",
  ];
}

const paginationShape = {
  pageIndex: z.number().int().min(0).optional().describe("0-based page index (default 0)"),
  pageQuantity: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Page size (default 50, max 100)"),
  direction: z
    .enum(["asc", "desc"])
    .optional()
    .describe("Sort direction; each sort key has a sensible default"),
};

/** Parent-firm filters accepted by both the firm and the challenge search. */
const firmParentShape = {
  propfirmId: z
    .array(z.string())
    .optional()
    .describe("Public firm slugs, e.g. ['ftmo']"),
  productTypes: z
    .array(z.string())
    .optional()
    .describe("Product types the firm must offer at least one of, e.g. 'CFD', 'Futures'"),
  tradedMarketTypes: z
    .array(z.string())
    .optional()
    .describe("Markets the firm must offer at least one of, e.g. 'forex', 'indices', 'commodities'"),
  tradingPlatforms: z
    .array(z.string())
    .optional()
    .describe("Platforms the firm must offer at least one of, e.g. 'MT5', 'cTrader', 'TradingView'"),
  isPreferredPartner: z.boolean().optional().describe("Only LuxAlgo preferred-partner firms when true"),
  availableIn: z
    .array(z.string())
    .optional()
    .describe("Country names the firm must NOT restrict, e.g. ['United States']"),
};

/** Challenge-rule filters. In the firm search, a firm matches when at least one of its challenges matches all of them. */
const challengePropertyShape = {
  challengeId: z.array(z.string()).optional().describe("Public challenge ids"),
  challengeName: z.string().optional().describe("Case-insensitive substring of the challenge name"),
  accountSizeMin: z.number().optional().describe("Minimum account size (inclusive)"),
  accountSizeMax: z.number().optional().describe("Maximum account size (inclusive)"),
  steps: z
    .number()
    .int()
    .optional()
    .describe("Exact evaluation step count (1 = instant/funded, 2 = two-step, …)"),
  stepsMin: z.number().int().optional().describe("Minimum step count (ignored when steps is set)"),
  stepsMax: z.number().int().optional().describe("Maximum step count (ignored when steps is set)"),
  priceMin: z.number().optional().describe("Minimum challenge fee (inclusive)"),
  priceMax: z.number().optional().describe("Maximum challenge fee (inclusive)"),
  profitSplitMin: z.number().optional().describe("Minimum trader profit-split percent"),
  maxLeverageMin: z.number().optional().describe("Minimum max leverage"),
  minTradingDaysMax: z
    .number()
    .optional()
    .describe("Maximum required minimum trading days (finds less-strict challenges)"),
  dailyLossMax: z
    .number()
    .optional()
    .describe("Upper bound on the daily-loss limit magnitude (smaller = stricter)"),
  maxLossMax: z.number().optional().describe("Upper bound on the overall-loss limit magnitude"),
  maxLossMode: z
    .array(z.enum(MAX_LOSS_MODES))
    .optional()
    .describe("Drawdown modes; challenges without a captured mode never match"),
  newsTrading: z.boolean().optional().describe("Whether news trading is allowed"),
  copyTrading: z.boolean().optional().describe("Whether copy trading is allowed"),
  autoTrading: z.boolean().optional().describe("Whether automated trading (EAs/bots) is allowed"),
  weekendHolding: z.boolean().optional().describe("Whether holding over the weekend is allowed"),
  overnightHolding: z.boolean().optional().describe("Whether holding overnight is allowed"),
  stoplossRequired: z.boolean().optional().describe("Whether a stop loss is required"),
  isFeeRefundable: z.boolean().optional().describe("Whether the challenge fee is refundable"),
  interval: z
    .array(z.string())
    .optional()
    .describe("Challenge fee intervals, e.g. 'one-time', 'monthly'"),
};

/** Offer filters. Defaults to live (active, unexpired) offers. */
const offerPropertyShape = {
  offerId: z.array(z.string()).optional().describe("Public offer ids"),
  promoCode: z.string().optional().describe("Case-insensitive substring of the promo code"),
  offerText: z
    .string()
    .optional()
    .describe("Case-insensitive search over promo code and offer descriptions"),
  isFeatured: z.boolean().optional().describe("Only featured offers when true"),
  discountIsPercent: z
    .boolean()
    .optional()
    .describe("true for percent discounts, false for absolute amounts"),
  discountMin: z.number().optional().describe("Minimum discount value"),
  discountMax: z.number().optional().describe("Maximum discount value"),
  includeInactive: z
    .boolean()
    .optional()
    .describe("When true, inactive offers are not hidden (default false)"),
  includeExpired: z
    .boolean()
    .optional()
    .describe("When true, ended offers are not hidden (default false)"),
};

/* ------------------------------------------------------------------ *
 * Natural challenge queries (challenge-query.ts) — not on the Claude address
 * ------------------------------------------------------------------ */

type ChallengeSearchArgs = Record<string, unknown>;

function challengePayload({ challenges, count }: { challenges: PropfirmChallenge[]; count: number }) {
  const { challenges: rows, offers, lifted } = liftChallengeOffers(challenges);
  return { count, challenges: rows, ...(lifted ? { offers } : {}) };
}

function hasIds(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : typeof value === "string" && value.length > 0;
}

function idsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((id): id is string => typeof id === "string");
  return typeof value === "string" && value ? [value] : [];
}

/** Every visible firm's slug and name (the directory has a few dozen). */
async function listFirms(): Promise<FirmRef[]> {
  const firms: FirmRef[] = [];
  for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
    const page = await queryPropfirms({ pageQuantity: "100", pageIndex: String(pageIndex) });
    firms.push(...page.firms.map(({ propfirmId, name }) => ({ propfirmId, name })));
    if (page.firms.length < 100 || firms.length >= page.count) break;
  }
  return firms;
}

type Interpretation = {
  /** Structured filters to try in order, each in place of `text`; the first with rows wins. */
  candidates: ChallengeSearchArgs[];
  /** The firms the text names, when it names one in the directory. */
  firms: FirmRef[];
  /** The text left after size and steps when it names no firm in the directory. */
  unknownFirm?: string;
};

/**
 * Reads a text query that matched nothing as account size + step count +
 * firm. Filters the caller set explicitly always win over what the text says.
 */
async function interpret(args: ChallengeSearchArgs): Promise<Interpretation> {
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) return { candidates: [], firms: [] };
  const parsed = parseChallengeText(text);
  const filters: ChallengeSearchArgs = {};
  if (parsed.accountSize !== undefined && args.accountSizeMin === undefined && args.accountSizeMax === undefined) {
    filters.accountSizeMin = parsed.accountSize;
    filters.accountSizeMax = parsed.accountSize;
  }
  if (parsed.steps !== undefined && args.steps === undefined && args.stepsMin === undefined && args.stepsMax === undefined) {
    filters.steps = parsed.steps;
  }

  const candidates: ChallengeSearchArgs[] = [];
  // The app's own text match on what is left ("FTMO" of "FTMO 100K").
  if (Object.keys(filters).length > 0) candidates.push(parsed.rest ? { ...filters, text: parsed.rest } : filters);
  if (!parsed.rest || hasIds(args.propfirmId)) return { candidates, firms: [] };

  // Else the firm the words name ("the 5ers", "funding pips", "ftmo swing").
  const match = matchFirms(parsed.rest, await listFirms());
  if (!match) return { candidates, firms: [], unknownFirm: parsed.rest };
  const propfirmId = match.firms.map((firm) => firm.propfirmId);
  if (match.leftover && args.challengeName === undefined) {
    candidates.push({ ...filters, propfirmId, challengeName: match.leftover });
  }
  candidates.push({ ...filters, propfirmId });
  return { candidates, firms: match.firms };
}

/** "2-step 100K" from the effective size and step filters, or "" when neither is exact. */
function wantedLabel(args: ChallengeSearchArgs): string {
  const parts: string[] = [];
  if (typeof args.steps === "number") parts.push(formatSteps(args.steps));
  if (typeof args.accountSizeMin === "number" && args.accountSizeMin === args.accountSizeMax) {
    parts.push(formatAccountSize(args.accountSizeMin));
  }
  return parts.join(" ");
}

/** What to say when nothing matched: the firm is not listed, or what the firm does list. */
async function noMatchHints(args: ChallengeSearchArgs, interpretation: Interpretation): Promise<string[]> {
  const effective = { ...args, ...(interpretation.candidates.at(-1) ?? {}) };
  const wanted = wantedLabel(effective);
  if (interpretation.unknownFirm !== undefined) {
    // The words may name challenges rather than a firm ("swing 300k"): say what they do match.
    if (interpretation.candidates.length > 0) {
      const byText = await queryPropfirmChallenges({ text: interpretation.unknownFirm, pageQuantity: "100" });
      if (byText.count > 0) {
        return [
          `No ${wanted ? `${wanted} ` : ""}challenge matches '${interpretation.unknownFirm}' with these filters. ` +
            `What matches '${interpretation.unknownFirm}' (steps, account sizes): ` +
            `${describeOfferedChallenges(byText.challenges).slice(0, 5).join(" | ")}.`,
        ];
      }
    }
    const firms = await listFirms();
    return [
      `No prop firm or challenge in LuxAlgo's prop-firm directory matches '${interpretation.unknownFirm}'. ` +
        `Firms listed: ${firms.map((firm) => `${firm.name} (${firm.propfirmId})`).join(", ")}. ` +
        "Pass a slug as propfirmId, with accountSizeMin/accountSizeMax and steps for the account size and step count.",
    ];
  }
  const firmIds = interpretation.firms.length > 0
    ? interpretation.firms.map((firm) => firm.propfirmId)
    : idsOf(args.propfirmId);
  if (firmIds.length === 0 || firmIds.length > 3) return [];
  const listed = await queryPropfirmChallenges({ propfirmId: firmIds.join(","), pageQuantity: "100" });
  if (listed.count === 0) {
    return [`No visible prop firm has the slug ${firmIds.map((id) => `'${id}'`).join(", ")}. Find slugs with propfirms_search.`];
  }
  return [
    `No ${wanted ? `${wanted} ` : ""}challenge matches these filters. ` +
      `What ${firmIds.length === 1 ? "this firm lists" : "these firms list"} (steps, account sizes): ` +
      `${describeOfferedChallenges(listed.challenges).join(" | ")}.`,
  ];
}

/**
 * propfirms_search_challenges off the Claude address. The caller's filters go
 * to the app as-is first, so every query that finds rows today answers
 * exactly as before. Only an empty answer to a text query is read as
 * size + steps + firm and retried with those structured filters (reported
 * as `interpretedAs`); if that is empty too, the result says why.
 */
async function searchChallenges(args: ChallengeSearchArgs): Promise<Record<string, unknown>> {
  const asked = await queryPropfirmChallenges(toQuery(args));
  if (asked.count > 0) return challengePayload(asked);

  const interpretation = await interpret(args);
  for (const candidate of interpretation.candidates) {
    const retried = await queryPropfirmChallenges(toQuery({ ...args, text: undefined, ...candidate }));
    if (retried.count > 0) return { ...challengePayload(retried), interpretedAs: candidate };
  }
  const warnings = [...(zeroResultWarnings(args) ?? []), ...(await noMatchHints(args, interpretation))];
  return { ...challengePayload(asked), warnings: warnings.length > 0 ? warnings : undefined };
}

/**
 * An id filter that takes a list or a single id ('ftmo' as well as
 * ['ftmo']). A widening of the list-only field: every call valid before is
 * still valid. toQuery sends either form as the same CSV.
 */
function idListOrOne(description: string) {
  return z.union([z.array(z.string()), z.string()]).optional().describe(description);
}

export function registerPropfirmTools(server: McpServer, toolset: Toolset) {
  const withOffers = toolset !== "directory";
  /*
    The Claude address is frozen while its directory review is open: there
    the tools keep their reviewed definitions and results byte for byte
    (test/smoke/claude-freeze.mjs). Everywhere else, ids may be passed on
    their own and challenge searches read natural queries (searchChallenges).
    Read at registration: hosted servers are built inside the request's surface.
  */
  const frozen = currentSurface().kind === "claude";
  // Spread after the shapes that define these keys: same position, wider type.
  const singleFirmId = frozen ? {} : { propfirmId: idListOrOne("Public firm slugs, e.g. ['ftmo']") };
  const singleChallengeId = frozen ? {} : { challengeId: idListOrOne("Public challenge ids") };
  server.registerTool(
    "propfirms_search",
    {
      title: "Search prop firms",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description:
        withOffers
          ? "Search LuxAlgo's prop-firm catalog (proprietary trading firms offering funded accounts). Combine firm filters (platforms, markets, payment/payout methods, country availability, Trustpilot, year founded) with nested challenge filters (account size, price, steps, profit split, trading rules) and offer filters — a firm matches when at least one of its challenges/offers matches all of them. Omit every filter to list all firms. Use include to nest the matching challenges, live offers, and the written overview; for one firm's full dossier prefer propfirms_get. Uncaptured (null) fields are omitted from results; nested challenges reference offers via offerIds into the firm-level offers list. This tool returns directory data (what exists and on what terms), not outcomes: for simulated pass odds on a challenge found here, use propfirms_pass_rates or propfirms_simulate with its firm and challenge ids."
          : "Search LuxAlgo's prop-firm catalog (proprietary trading firms offering funded accounts). Combine firm filters (platforms, markets, payment/payout methods, country availability, Trustpilot, year founded) with nested challenge filters (account size, price, steps, profit split, trading rules) — a firm matches when at least one of its challenges matches all of them. Omit every filter to list all firms. Use include to nest the matching challenges and the written overview; for one firm's full dossier prefer propfirms_get. Uncaptured (null) fields are omitted from results. This tool returns directory data (what exists and on what terms), not outcomes: for simulated pass odds on a challenge found here, use propfirms_pass_rates or propfirms_simulate with its firm and challenge ids.",
      inputSchema: z.object({
        text: z
          .string()
          .optional()
          .describe("Case-insensitive search over firm name and slug, e.g. 'ftmo'"),
        ...firmParentShape,
        paymentMethods: z
          .array(z.string())
          .optional()
          .describe("Payment methods the firm must accept at least one of, e.g. 'Crypto', 'PayPal'"),
        payoutMethods: z
          .array(z.string())
          .optional()
          .describe("Payout methods the firm must offer at least one of, e.g. 'Bank Transfer', 'Crypto'"),
        countryIso2: z
          .array(z.string())
          .optional()
          .describe("ISO-2 headquarters countries, e.g. ['GB', 'US']"),
        currency: z.array(z.string()).optional().describe("Account currencies, e.g. ['usd', 'eur']"),
        minTrustPilotScore: z.number().optional().describe("Minimum Trustpilot score"),
        minTrustPilotCount: z.number().optional().describe("Minimum Trustpilot review count"),
        minYearFounded: z.number().int().optional().describe("Inclusive minimum year founded"),
        maxYearFounded: z.number().int().optional().describe("Inclusive maximum year founded"),
        ...(withOffers
          ? {
              hasActiveOffer: z
                .boolean()
                .optional()
                .describe("When true, the firm must currently have a live (active, unexpired) offer"),
            }
          : {}),
        ...challengePropertyShape,
        ...(withOffers ? offerPropertyShape : {}),
        ...singleFirmId,
        ...singleChallengeId,
        include: z
          .array(withOffers ? z.enum(["challenges", "offers", "overview"]) : z.enum(["challenges", "overview"]))
          .optional()
          .describe("Extra payloads to nest on each firm (only children matching the filters are returned)"),
        sort: z.enum(FIRM_SORT_KEYS).optional().describe("Sort key (default name)"),
        ...paginationShape,
      }),
    },
    async (args) => {
      const { firms, count } = await queryPropfirms(toQuery(args));
      const warnings = count === 0 ? zeroResultWarnings(args) : undefined;
      return json(compact({ count, firms: firms.map(withOffers ? liftFirmOffers : withoutOffers), warnings }));
    },
  );

  server.registerTool(
    "propfirms_get",
    {
      title: "Get a prop firm",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description:
        (withOffers
          ? "One prop firm's full dossier by slug: general profile (platforms, markets, payments, Trustpilot, restricted countries), every challenge with its rules, live offers with promo codes and affiliate links, and the written overview (about, rules, payout policy, FAQ). Find slugs with propfirms_search. Uncaptured (null) fields are omitted; challenges reference applicable offers via offerIds into the firm-level offers list."
          : "One prop firm's full dossier by slug: general profile (platforms, markets, payments, Trustpilot, restricted countries), every challenge with its rules, and the written overview (about, rules, payout policy, FAQ). Find slugs with propfirms_search. Uncaptured (null) fields are omitted.") +
        " For simulated pass odds on this firm's challenges (reference archetypes, same engine as luxalgo.com/prop-firms), use propfirms_pass_rates.",
      inputSchema: z.object({
        propfirmId: z.string().min(1).describe("Public firm slug, e.g. 'ftmo'"),
      }),
    },
    async ({ propfirmId }) => {
      const { firms } = await queryPropfirms({
        propfirmId,
        include: withOffers ? "challenges,offers,overview" : "challenges,overview",
      });
      const firm = firms[0];
      if (!firm) {
        return toolError(
          `Unknown prop firm slug '${propfirmId}'. Find slugs with propfirms_search.`,
        );
      }
      const dossier = withOffers ? liftFirmOffers(firm) : withoutOffers(firm);
      return json(compact({ firm: frozen ? dossier : trimDossier(dossier) }));
    },
  );

  server.registerTool(
    "propfirms_search_challenges",
    {
      title: "Search prop-firm challenges",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description:
        "Search funded-account challenges across all visible prop firms. Filter by challenge rules (account size, fee, steps, profit split, drawdown mode, news/copy/auto trading, weekend holding, …) and by parent-firm properties. Pass propfirmId to list one firm's challenges, or challengeId to fetch specific ones." +
        (withOffers
          ? " include=['offers'] returns a deduplicated top-level offers list, with each challenge referencing its applicable offers via offerIds (firm-wide offers included)."
          : "") +
        " Uncaptured (null) rule fields are omitted from results and never match filters. This returns each challenge's listed rules and terms, not outcomes: to simulate a challenge found here pass its ids to propfirms_simulate or propfirms_pass_rates, and to screen one strategy across many challenges at once use propfirms_validate_strategy.",
      inputSchema: z.object({
        text: z
          .string()
          .optional()
          .describe("Case-insensitive search over challenge name and firm name/slug"),
        ...challengePropertyShape,
        ...firmParentShape,
        ...singleFirmId,
        ...singleChallengeId,
        ...(withOffers
          ? {
              include: z
                .array(z.enum(["offers"]))
                .optional()
                .describe("Pass ['offers'] to attach live offers that apply to each challenge"),
            }
          : {}),
        sort: z
          .enum(CHALLENGE_SORT_KEYS)
          .optional()
          .describe("Sort key (default accountSize descending)"),
        ...paginationShape,
      }),
    },
    async (args) => {
      if (!frozen) return json(compact(await searchChallenges(args)));
      const { challenges, count } = await queryPropfirmChallenges(toQuery(args));
      const { challenges: rows, offers, lifted } = liftChallengeOffers(challenges);
      const warnings = count === 0 ? zeroResultWarnings(args) : undefined;
      return json(
        compact({ count, challenges: rows, ...(lifted ? { offers } : {}), warnings }),
      );
    },
  );

  // Offers are promo codes and affiliate links: not on the "directory" toolset.
  if (!withOffers) return;

  server.registerTool(
    "propfirms_search_offers",
    {
      title: "Search prop-firm offers",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description:
        "Search promotional offers (discounts and promo codes) across prop firms — defaults to live (active, unexpired) offers only. propfirmId narrows to one firm; challengeId resolves the offers that apply to a challenge (firm-wide offers included). Every offer carries the promo code, discount, end date, and affiliate link.",
      inputSchema: z.object({
        text: z
          .string()
          .optional()
          .describe("Case-insensitive search over promo code, descriptions, and firm name/slug"),
        // Never on the Claude address (no offers there), so always the widened ids.
        propfirmId: idListOrOne("Public firm slugs, e.g. ['ftmo']"),
        challengeId: idListOrOne(
          "Public challenge ids; an offer matches when it applies to at least one (all-challenges offers match that firm's challenges)",
        ),
        ...offerPropertyShape,
        isActive: z
          .boolean()
          .optional()
          .describe("Defaults to live offers only; pass false to look at inactive offers"),
        sort: z
          .enum(OFFER_SORT_KEYS)
          .optional()
          .describe("Sort key (default: featured first, then discount)"),
        ...paginationShape,
      }),
    },
    async (args) => {
      const { offers, count } = await queryPropfirmOffers(toQuery(args));
      // The API sorts null discount values first on a descending discount
      // sort, drowning real deals under affiliate-link-only entries — put
      // them last within the page and say so.
      let rows = offers;
      let warnings: string[] | undefined;
      if (args.sort === "discountValue") {
        const withValue = rows.filter((offer) => offer.discountValue !== null);
        const withoutValue = rows.filter((offer) => offer.discountValue === null);
        if (withValue.length > 0 && withoutValue.length > 0) {
          rows = [...withValue, ...withoutValue];
          warnings = [
            `${withoutValue.length} offer(s) have no discountValue (affiliate-link-only) and were moved to the end of this page; pass discountMin to exclude them.`,
          ];
        }
      }
      return json(compact({ count, offers: rows, warnings }));
    },
  );
}

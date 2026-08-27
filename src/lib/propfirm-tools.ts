/*
  The prop-firm analysis tools — a faithful mapping of the three public
  query endpoints (/api/propfirms/query, /challenges/query, /offers/query)
  plus a one-firm convenience getter. All read-only and keyless. Tool
  params mirror the public API contract names exactly; arrays become CSV
  query params and numbers/booleans are stringified at the boundary.
*/
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type PropfirmChallenge,
  type PropfirmFirm,
  type PropfirmOffer,
  queryPropfirmChallenges,
  queryPropfirmOffers,
  queryPropfirms,
} from "./api.js";

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

function json(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

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

/**
 * API rows carry ~20 always-null structured rule fields per challenge (the
 * capture pipeline hasn't backfilled them yet). Null means "not captured",
 * which reads the same as absence to an agent, so drop null/undefined
 * properties recursively to keep tool output compact.
 */
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

export function registerPropfirmTools(server: McpServer) {
  server.registerTool(
    "propfirms_search",
    {
      title: "Search prop firms",
      description:
        "Search LuxAlgo's prop-firm catalog (proprietary trading firms offering funded accounts). Combine firm filters (platforms, markets, payment/payout methods, country availability, Trustpilot, year founded) with nested challenge filters (account size, price, steps, profit split, trading rules) and offer filters — a firm matches when at least one of its challenges/offers matches all of them. Omit every filter to list all firms. Use include to nest the matching challenges, live offers, and the written overview; for one firm's full dossier prefer propfirms_get. Uncaptured (null) fields are omitted from results; nested challenges reference offers via offerIds into the firm-level offers list. This tool returns directory data (what exists and on what terms), not outcomes: for simulated pass odds on a challenge found here, use propfirms_pass_rates or propfirms_simulate with its firm and challenge ids.",
      inputSchema: {
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
        hasActiveOffer: z
          .boolean()
          .optional()
          .describe("When true, the firm must currently have a live (active, unexpired) offer"),
        ...challengePropertyShape,
        ...offerPropertyShape,
        include: z
          .array(z.enum(["challenges", "offers", "overview"]))
          .optional()
          .describe("Extra payloads to nest on each firm (only children matching the filters are returned)"),
        sort: z.enum(FIRM_SORT_KEYS).optional().describe("Sort key (default name)"),
        ...paginationShape,
      },
    },
    async (args) => {
      const { firms, count } = await queryPropfirms(toQuery(args));
      const warnings = count === 0 ? zeroResultWarnings(args) : undefined;
      return json(compact({ count, firms: firms.map(liftFirmOffers), warnings }));
    },
  );

  server.registerTool(
    "propfirms_get",
    {
      title: "Get a prop firm",
      description:
        "One prop firm's full dossier by slug: general profile (platforms, markets, payments, Trustpilot, restricted countries), every challenge with its rules, live offers with promo codes and affiliate links, and the written overview (about, rules, payout policy, FAQ). Find slugs with propfirms_search. Uncaptured (null) fields are omitted; challenges reference applicable offers via offerIds into the firm-level offers list. For simulated pass odds on this firm's challenges (reference archetypes, same engine as luxalgo.com/prop-firms), use propfirms_pass_rates.",
      inputSchema: {
        propfirmId: z.string().min(1).describe("Public firm slug, e.g. 'ftmo'"),
      },
    },
    async ({ propfirmId }) => {
      const { firms } = await queryPropfirms({
        propfirmId,
        include: "challenges,offers,overview",
      });
      const firm = firms[0];
      if (!firm) {
        return toolError(
          `Unknown prop firm slug '${propfirmId}'. Find slugs with propfirms_search.`,
        );
      }
      return json(compact({ firm: liftFirmOffers(firm) }));
    },
  );

  server.registerTool(
    "propfirms_search_challenges",
    {
      title: "Search prop-firm challenges",
      description:
        "Search funded-account challenges across all visible prop firms. Filter by challenge rules (account size, fee, steps, profit split, drawdown mode, news/copy/auto trading, weekend holding, …) and by parent-firm properties. Pass propfirmId to list one firm's challenges, or challengeId to fetch specific ones. include=['offers'] returns a deduplicated top-level offers list, with each challenge referencing its applicable offers via offerIds (firm-wide offers included). Uncaptured (null) rule fields are omitted from results and never match filters. This returns each challenge's listed rules and terms, not outcomes: to simulate a challenge found here pass its ids to propfirms_simulate or propfirms_pass_rates, and to screen one strategy across many challenges at once use propfirms_validate_strategy.",
      inputSchema: {
        text: z
          .string()
          .optional()
          .describe("Case-insensitive search over challenge name and firm name/slug"),
        ...challengePropertyShape,
        ...firmParentShape,
        include: z
          .array(z.enum(["offers"]))
          .optional()
          .describe("Pass ['offers'] to attach live offers that apply to each challenge"),
        sort: z
          .enum(CHALLENGE_SORT_KEYS)
          .optional()
          .describe("Sort key (default accountSize descending)"),
        ...paginationShape,
      },
    },
    async (args) => {
      const { challenges, count } = await queryPropfirmChallenges(toQuery(args));
      const { challenges: rows, offers, lifted } = liftChallengeOffers(challenges);
      const warnings = count === 0 ? zeroResultWarnings(args) : undefined;
      return json(
        compact({ count, challenges: rows, ...(lifted ? { offers } : {}), warnings }),
      );
    },
  );

  server.registerTool(
    "propfirms_search_offers",
    {
      title: "Search prop-firm offers",
      description:
        "Search promotional offers (discounts and promo codes) across prop firms — defaults to live (active, unexpired) offers only. propfirmId narrows to one firm; challengeId resolves the offers that apply to a challenge (firm-wide offers included). Every offer carries the promo code, discount, end date, and affiliate link.",
      inputSchema: {
        text: z
          .string()
          .optional()
          .describe("Case-insensitive search over promo code, descriptions, and firm name/slug"),
        propfirmId: z.array(z.string()).optional().describe("Public firm slugs, e.g. ['ftmo']"),
        challengeId: z
          .array(z.string())
          .optional()
          .describe(
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
      },
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

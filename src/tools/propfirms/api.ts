/*
  Prop-firm directory — the three public query routes of the app API. Each
  takes composable filters as query-string params (numbers/booleans/CSVs
  already stringified by the tool layer) and returns `{ <rows>, count }`.
  Hidden firms never appear; offers default to live (active, unexpired) ones.
*/
import { appGet } from "../../platform/app-client.js";

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

export async function queryPropfirms(params: PropfirmQueryParams): Promise<{ firms: PropfirmFirm[]; count: number }> {
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

/* Canonical LuxAlgo URLs the library tools put in every payload so agents can cite pages. */
import { APP_API_ORIGIN, SITE_ORIGIN } from "../../platform/app-client.js";
import { CHART_ORIGIN } from "../_shared/vela.js";

export const conceptUrl = (slug: string) => `${SITE_ORIGIN}/library/concept/${slug}/`;
export const conceptMdUrl = (slug: string) => `${SITE_ORIGIN}/library/concept/${slug}.md`;
export const familyUrl = (key: string) => `${SITE_ORIGIN}/library/family/${key}/`;
export const familyMdUrl = (key: string) => `${SITE_ORIGIN}/library/family/${key}.md`;
export const indicatorUrl = (slug: string) => `${SITE_ORIGIN}/library/indicator/${slug}/`;
export const quantUrl = (pineScriptCodeId: string) =>
  `${APP_API_ORIGIN}/quant?pineScriptCodeId=${encodeURIComponent(pineScriptCodeId)}`;

/*
  The chart link to give users: the indicator opened on a Vela chart. quantUrl above is
  kept unchanged for existing clients; the app redirects it to this same address.
*/
export const chartUrl = (pineScriptCodeId: string) =>
  `${CHART_ORIGIN}/chart?pineScriptCodeId=${encodeURIComponent(pineScriptCodeId)}`;

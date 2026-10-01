/* Canonical LuxAlgo URLs the library tools put in every payload so agents can cite pages. */
import { APP_API_ORIGIN, SITE_ORIGIN } from "../../platform/app-client.js";

export const conceptUrl = (slug: string) => `${SITE_ORIGIN}/library/concept/${slug}/`;
export const conceptMdUrl = (slug: string) => `${SITE_ORIGIN}/library/concept/${slug}.md`;
export const familyUrl = (key: string) => `${SITE_ORIGIN}/library/family/${key}/`;
export const familyMdUrl = (key: string) => `${SITE_ORIGIN}/library/family/${key}.md`;
export const indicatorUrl = (slug: string) => `${SITE_ORIGIN}/library/indicator/${slug}/`;
export const quantUrl = (pineScriptCodeId: string) =>
  `${APP_API_ORIGIN}/quant?pineScriptCodeId=${encodeURIComponent(pineScriptCodeId)}`;

/*
  Where the charts live. The charts are moving to their own host (vela.luxalgo.com)
  while the API and sign-in stay on the app, so this is its own setting: unset, it is
  the app origin and `chart_url` equals `quant_url`; set LUXALGO_CHART_ORIGIN once the
  chart host is live. The path stays `/quant`, which the app redirects to the chart's
  current address on either host, so the link works before and after the move.
*/
const CHART_ORIGIN = process.env.LUXALGO_CHART_ORIGIN ?? APP_API_ORIGIN;

export const chartUrl = (pineScriptCodeId: string) =>
  `${CHART_ORIGIN}/quant?pineScriptCodeId=${encodeURIComponent(pineScriptCodeId)}`;

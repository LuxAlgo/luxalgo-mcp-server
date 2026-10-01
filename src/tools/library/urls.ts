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
  The chart link to give users. It always goes through the app: the app redirects
  `/quant` to the chart's current address, on vela.luxalgo.com once the app's
  `vela-live` flag is on for that user, so this link never needs its own switch.
*/
export const chartUrl = quantUrl;

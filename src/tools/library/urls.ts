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
  Where the charts live: Vela, on its own host, while the API and sign-in stay on the
  app. LUXALGO_CHART_ORIGIN points chart links at a non-production Vela.
*/
const CHART_ORIGIN = process.env.LUXALGO_CHART_ORIGIN ?? "https://vela.luxalgo.com";

/*
  The chart link to give users: the indicator opened on a Vela chart. quantUrl above is
  kept unchanged for existing clients; the app redirects it to this same address.
*/
export const chartUrl = (pineScriptCodeId: string) =>
  `${CHART_ORIGIN}/chart?pineScriptCodeId=${encodeURIComponent(pineScriptCodeId)}`;

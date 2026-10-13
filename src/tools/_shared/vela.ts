/*
  Where the charts live: Vela, LuxAlgo's next-generation charting platform, on
  its own host, while the API and sign-in stay on the app. Shared by every
  domain that links to it. LUXALGO_CHART_ORIGIN points these links at a
  non-production Vela.
*/
export const CHART_ORIGIN = process.env.LUXALGO_CHART_ORIGIN ?? "https://vela.luxalgo.com";

/** Vela's chart page: the general link into the charts. */
export const VELA_CHART_URL = `${CHART_ORIGIN}/chart`;

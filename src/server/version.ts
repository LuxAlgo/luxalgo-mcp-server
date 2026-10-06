/*
  The identity every entry announces in `initialize` (serverInfo). The
  version is written here by hand rather than read from package.json at
  runtime so the module stays a plain import on every host (Vercel's bundler
  included); `npm test` asserts it matches package.json, so a release bump
  that forgets this file fails CI instead of shipping a stale version.
*/
export const SERVER_NAME = "luxalgo";
export const SERVER_VERSION = "1.5.0";

/*
  The `instructions` every entry sends in `initialize`: what LuxAlgo and Vela are,
  so an agent knows where a chart link takes the user. Keep it short; it is read
  by models on every connection.
*/
export const SERVER_INSTRUCTIONS = [
  "LuxAlgo is the trading technology company that built Vela, the next-generation charting platform.",
  "Vela is at https://vela.luxalgo.com/chart, with state-of-the-art charts and Quant, our coding agent, built in.",
  "When a tool returns chart_url, give the user that link to open the indicator on a Vela chart (quant_url is kept only for older clients).",
].join(" ");

/*
  The Edge Stats tools — hosted session statistics from the open-source
  LuxAlgo edge-stats engine (github.com/LuxAlgo/edge-stats). Read-only and
  keyless: a nightly workflow in that repo runs the real engine over free
  market data and publishes derived artifacts (a manifest plus every
  preset × symbol result envelope) to a rolling public GitHub release;
  these tools serve those envelopes verbatim. No raw bars, no vendor
  keys, nothing user-specific — safe on every entry, hosted included.

  Statistical honesty is preserved end to end: every result carries N, a
  Wilson 95% confidence interval, minimum-sample guards, a stability
  split, per-year counts, and the engine's disclaimer, exactly as
  computed. Results are historical conditional frequencies, never
  predictions. For arbitrary composed queries (any outcome × any
  conditions) or your own market data, run edge-stats locally — its own
  MCP server exposes the full engine over your local store.
*/
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { errorMessage, json, toolError } from "../_shared/result.js";
import { symbolChartUrl, velaInstrumentId, velaLinksHere } from "../_shared/vela.js";
import { answersFrozen } from "../_shared/surface.js";
import { hostedData, type HostedManifest, type HostedPreset, type HostedSymbol } from "./hosted-store.js";

/*
  Vela chart links for hosted symbols. A hosted symbol is one exact market (its
  adapter is the data source, e.g. Binance spot BTCUSDT), so it maps to Vela's
  source-qualified id (`binance:BTCUSDT`); an adapter Vela has no source for gets no
  link. The interval follows the question: presets about what happens inside a
  session (opening range, initial balance, opening gaps, time of day) open on
  15-minute bars; session-level ones (seasonality, events, levels, session shape,
  streaks, volatility, session fair value gaps) on daily bars.
*/
const INTRADAY_CATEGORIES = new Set(["opening-range", "initial-balance", "gaps", "time-of-day"]);

function chartLinkFor(symbol: HostedSymbol | undefined, tf: string): { chart_url?: string } {
  const instrument = symbol ? velaInstrumentId(symbol.adapter, symbol.symbol) : null;
  return instrument ? { chart_url: symbolChartUrl(instrument, tf) } : {};
}

function presetTimeframe(manifest: HostedManifest, presetId: string): string {
  const category = manifest.presets.find((p) => p.id === presetId)?.category;
  return category !== undefined && INTRADAY_CATEGORIES.has(category) ? "15" : "D";
}

/*
  Opening-gap questions need a session that opens after a pause in trading.
  A market that trades around the clock (crypto) has no such pause: its
  hosted sessions are calendar days, each opening a minute after the last one
  closed, so a "gap" is one minute of price movement and fills almost every
  time. Those numbers say nothing a trader can use, so the gap presets are
  refused there with the reason and the presets that do apply.
*/
const GAP_OUTCOME = /^gap/i;

function measuresOpeningGaps(preset: HostedPreset): boolean {
  return preset.category === "gaps" || GAP_OUTCOME.test(preset.outcome);
}

function tradesAroundTheClock(symbol: HostedSymbol): boolean {
  return symbol.assetClass === "crypto";
}

function gapRefusal(preset: HostedPreset, symbol: HostedSymbol, presets: HostedPreset[]): string {
  const applicable = presets.filter((p) => !measuresOpeningGaps(p)).map((p) => p.id);
  return (
    `'${preset.id}' measures opening gaps, and ${symbol.symbol} trades around the clock: its sessions are ` +
    "calendar days that open one minute after the previous one closed, so the gap is a minute of price " +
    "movement and fills almost every time. That number says nothing about trading, so it is not served " +
    `for ${symbol.symbol}. Presets that apply to ${symbol.symbol}: ${applicable.join(", ")}.`
  );
}

export function registerEdgeTools(server: McpServer) {
  // Chart links on every address but Claude's (see _shared/vela.ts).
  const links = velaLinksHere();
  const frozen = answersFrozen();
  server.registerTool(
    "edge_symbols",
    {
      title: "Hosted Edge Stats coverage",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description:
        "What the hosted Edge Stats store covers: the symbols, their session calendars, coverage windows, session counts, and when the nightly build last ran. Session statistics (how often a setup actually worked, with sample sizes and confidence intervals) come from the open-source edge-stats engine over free market data. Start here, then edge_presets for the questions you can ask, then edge_report for a result." +
        (links ? " Each symbol carries `chart_url`, the link that opens that market on a Vela chart." : ""),
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const { manifest } = await hostedData();
        return json({
          builtAt: manifest.builtAt,
          engineVersion: manifest.engineVersion,
          commit: manifest.commit,
          symbols: links ? manifest.symbols.map((s) => ({ ...s, ...chartLinkFor(s, "D") })) : manifest.symbols,
          note: manifest.note,
          source: manifest.source,
          localEngine:
            "For your own symbols, your own data, or arbitrary composed queries, run edge-stats locally: https://github.com/LuxAlgo/edge-stats",
        });
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "edge_presets",
    {
      title: "List Edge Stats report presets",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description:
        "The catalog of session-statistics questions the hosted store precomputes nightly — gap fills, opening-range breakouts, day-of-week effects, event-day behavior, and more. Each preset states in plain language what its number means. Returns preset ids for edge_report.",
      inputSchema: z.object({
        category: z
          .string()
          .optional()
          .describe("Narrow to one category (the result lists all categories)"),
      }),
    },
    async ({ category }) => {
      try {
        const { manifest } = await hostedData();
        const categories = [...new Set(manifest.presets.map((p) => p.category))].sort();
        if (category !== undefined && !categories.includes(category)) {
          return toolError(`unknown category '${category}' — categories: ${categories.join(", ")}`);
        }
        const presets = manifest.presets
          .filter((p) => category === undefined || p.category === category)
          .map((p) => {
            const row = {
              id: p.id,
              title: p.title,
              category: p.category,
              summary: p.summary,
              groupBy: p.groupBy,
            };
            if (frozen || !measuresOpeningGaps(p)) return row;
            const roundTheClock = manifest.symbols.filter(tradesAroundTheClock).map((s) => s.symbol);
            return roundTheClock.length > 0 ? { ...row, not_applicable_to: roundTheClock } : row;
          });
        return json({ categories, presets });
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "edge_report",
    {
      title: "Get a hosted Edge Stats report",
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      description:
        "One precomputed session-statistics result: P(outcome | conditions) for a preset on a hosted symbol, in the engine's full honesty envelope — the estimate with N and a Wilson 95% confidence interval, minimum-sample guards, a first-half vs second-half stability split, per-year counts, the value distribution where the outcome is continuous, and the disclaimer. Historical conditional frequencies, not predictions. Preset ids come from edge_presets; symbols from edge_symbols." +
        (links ? " `chart_url` opens the symbol on a Vela chart at an interval that suits the preset." : ""),
      inputSchema: z.object({
        preset: z.string().min(1).describe("Preset id, e.g. 'gap-fill' — see edge_presets"),
        symbol: z.string().min(1).describe("Hosted symbol, e.g. 'BTCUSDT' — see edge_symbols"),
      }),
    },
    async ({ preset, symbol }) => {
      try {
        const { manifest, results } = await hostedData();
        const symbolKey = symbol.toUpperCase();
        const hostedSymbol = manifest.symbols.find((s) => s.symbol === symbolKey);
        if (!hostedSymbol) {
          return toolError(
            `symbol '${symbol}' is not in the hosted store — hosted symbols: ${manifest.symbols
              .map((s) => s.symbol)
              .join(", ")}. For your own symbols, run edge-stats locally.`,
          );
        }
        const hostedPreset = manifest.presets.find((p) => p.id === preset);
        if (!hostedPreset) {
          const near = manifest.presets
            .map((p) => p.id)
            .filter((id) => id.includes(preset) || preset.includes(id))
            .slice(0, 3);
          return toolError(
            `unknown preset '${preset}'${near.length > 0 ? ` — did you mean: ${near.join(", ")}?` : ""} Use edge_presets for the catalog.`,
          );
        }
        if (!frozen && measuresOpeningGaps(hostedPreset) && tradesAroundTheClock(hostedSymbol)) {
          return toolError(gapRefusal(hostedPreset, hostedSymbol, manifest.presets));
        }
        const row = results.find((r) => r.preset === preset && r.symbol === symbolKey);
        if (!row) {
          return toolError(
            `no precomputed result for '${preset}' on ${symbolKey} in the current nightly build — try again after the next build, or run edge-stats locally.`,
          );
        }
        if ("error" in row) {
          return toolError(
            `preset '${preset}' is not applicable to ${symbolKey} in the hosted store: ${row.error}`,
          );
        }
        const chart = links
          ? chartLinkFor(manifest.symbols.find((s) => s.symbol === symbolKey), presetTimeframe(manifest, preset))
          : {};
        return json({ builtAt: manifest.builtAt, ...row.result, ...chart });
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  );
}

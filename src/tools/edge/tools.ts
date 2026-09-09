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
import { hostedData } from "./hosted-store.js";

export function registerEdgeTools(server: McpServer) {
  server.registerTool(
    "edge_symbols",
    {
      title: "Hosted Edge Stats coverage",
      description:
        "What the hosted Edge Stats store covers: the symbols, their session calendars, coverage windows, session counts, and when the nightly build last ran. Session statistics (how often a setup actually worked, with sample sizes and confidence intervals) come from the open-source edge-stats engine over free market data. Start here, then edge_presets for the questions you can ask, then edge_report for a result.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const { manifest } = await hostedData();
        return json({
          builtAt: manifest.builtAt,
          engineVersion: manifest.engineVersion,
          commit: manifest.commit,
          symbols: manifest.symbols,
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
          .map((p) => ({
            id: p.id,
            title: p.title,
            category: p.category,
            summary: p.summary,
            groupBy: p.groupBy,
          }));
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
      description:
        "One precomputed session-statistics result: P(outcome | conditions) for a preset on a hosted symbol, in the engine's full honesty envelope — the estimate with N and a Wilson 95% confidence interval, minimum-sample guards, a first-half vs second-half stability split, per-year counts, the value distribution where the outcome is continuous, and the disclaimer. Historical conditional frequencies, not predictions. Preset ids come from edge_presets; symbols from edge_symbols.",
      inputSchema: z.object({
        preset: z.string().min(1).describe("Preset id, e.g. 'gap-fill' — see edge_presets"),
        symbol: z.string().min(1).describe("Hosted symbol, e.g. 'BTCUSDT' — see edge_symbols"),
      }),
    },
    async ({ preset, symbol }) => {
      try {
        const { manifest, results } = await hostedData();
        const symbolKey = symbol.toUpperCase();
        if (!manifest.symbols.some((s) => s.symbol === symbolKey)) {
          return toolError(
            `symbol '${symbol}' is not in the hosted store — hosted symbols: ${manifest.symbols
              .map((s) => s.symbol)
              .join(", ")}. For your own symbols, run edge-stats locally.`,
          );
        }
        if (!manifest.presets.some((p) => p.id === preset)) {
          const near = manifest.presets
            .map((p) => p.id)
            .filter((id) => id.includes(preset) || preset.includes(id))
            .slice(0, 3);
          return toolError(
            `unknown preset '${preset}'${near.length > 0 ? ` — did you mean: ${near.join(", ")}?` : ""} Use edge_presets for the catalog.`,
          );
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
        return json({ builtAt: manifest.builtAt, ...row.result });
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  );
}

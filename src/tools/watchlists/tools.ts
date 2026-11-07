/*
  The member's watchlists, the same lists Vela shows on the web and in the
  Vela apps (the app's /api/quant/watchlists routes). Every route needs a
  signed-in member, so every tool is protected; plan limits (how many lists,
  how many symbols per list) are the app's, answered as a 403 that the auth
  wrapper turns into the plan message (docs/auth.md §6).

  A list's symbols are saved as a whole: adding or removing reads the list,
  edits its rows and saves them with the `updatedAt` it read (`ifUpdatedAt`).
  When another device saved the list in between, the app answers 409 and
  writes nothing; the tool reads again and retries once.

  No delete: the app's MCP allowlist has none, and neither has this server.
*/
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerProtectedTool } from "../../auth/protected-tool.js";
import type { AuthRuntime } from "../../auth/runtime.js";
import { AppApiError, AppAuthError, AppPermissionError, appGet, appSend, isNotFound } from "../../platform/app-client.js";
import { guarded, ok, textError } from "../_shared/result.js";
import {
  MARKET_INPUT_HELP,
  marketChartUrl,
  marketId,
  marketKey,
  marketRow,
  marketWords,
  parseMarketInput,
  rowMarket,
  rowWords,
  type MemberMarket,
  type WatchlistRow,
} from "../_shared/markets.js";

type Watchlist = { id: string; name: string; symbols: WatchlistRow[]; createdAt: string; updatedAt: string };

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

const PLAN_NOTE =
  "How many watchlists and symbols per list the member may have comes from their LuxAlgo plan: at a limit the call answers with the limit and where to upgrade, and nothing is saved.";
const CONFIRM_NOTE = "It changes the member's account, so the chat app may ask the user to confirm first.";

const watchlistIdInput = z.string().min(1).max(128).describe("The watchlist's id, from watchlists_list.");
const marketsInput = z
  .array(z.string().min(1).max(60))
  .min(1)
  .max(50)
  .describe(`Markets, each ${MARKET_INPUT_HELP}`);

const path = (id: string) => `/api/quant/watchlists/${encodeURIComponent(id)}`;

/** One row for a result: its market in words, its id and its Vela chart link. */
function rowView(row: WatchlistRow) {
  const market = rowMarket(row);
  return {
    market: marketId(market),
    words: rowWords(row),
    category: row.category,
    ...(row.section ? { section: row.section } : {}),
    chart_url: marketChartUrl(market),
  };
}

/** Parses every input market; the first that is not one is the error. */
function parseAll(inputs: string[]): { markets: MemberMarket[] } | { error: string } {
  const markets: MemberMarket[] = [];
  for (const input of inputs) {
    const parsed = parseMarketInput(input);
    if ("error" in parsed) return { error: `Nothing was saved: ${parsed.error}.` };
    markets.push(parsed);
  }
  return { markets };
}

const list = (items: string[]): string =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/**
 * Reads the list, lets `edit` compute its new rows, and saves them only if the
 * list is unchanged since the read; on a 409 reads again and retries once.
 */
async function editSymbols<T>(
  id: string,
  edit: (current: Watchlist) => { rows: WatchlistRow[]; changed: boolean; outcome: T },
): Promise<{ watchlist: Watchlist; rows: WatchlistRow[]; changed: boolean; outcome: T } | { missing: true } | { stale: true }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let current: Watchlist;
    try {
      current = await appGet<Watchlist>(path(id));
    } catch (error) {
      if (error instanceof AppAuthError || error instanceof AppPermissionError) throw error;
      if (isNotFound(error)) return { missing: true };
      throw error;
    }
    const { rows, changed, outcome } = edit(current);
    if (!changed) return { watchlist: current, rows: current.symbols, changed, outcome };
    try {
      const saved = await appSend<{ ok: boolean; updatedAt?: string }>("PATCH", path(id), {
        body: { kind: "symbols", symbols: rows, ifUpdatedAt: current.updatedAt },
      });
      if (!saved.ok) return { missing: true };
      return { watchlist: current, rows, changed, outcome };
    } catch (error) {
      if (error instanceof AppAuthError || error instanceof AppPermissionError) throw error;
      if (error instanceof AppApiError && error.status === 409) continue; // saved elsewhere since the read: read again
      if (isNotFound(error)) return { missing: true };
      throw error;
    }
  }
  return { stale: true };
}

const MISSING = (id: string) =>
  textError(`No watchlist with the id "${id}" in this account (it may have been deleted). Call watchlists_list for the member's lists.`);
const STALE = textError(
  "Nothing was saved: the watchlist changed on another device twice while this was being saved. Try again in a moment.",
);

export function registerWatchlistTools(server: McpServer, runtime: AuthRuntime) {
  registerProtectedTool(
    server,
    runtime,
    "watchlists_list",
    {
      title: "My watchlists",
      description:
        "The signed-in member's watchlists, the same lists Vela shows on the web and in the Vela apps: each list's id and name with every symbol in it, as the market it streams (source:TICKER), its category and section, and a Vela chart link (chart_url). Use it to answer what the member watches, and before watchlists_add_symbols or watchlists_remove_symbols to get a list's id. It carries no prices. An empty answer means the member has no watchlist yet (watchlists_create makes one).",
      inputSchema: z.object({}),
      annotations: READ,
    },
    async () =>
      guarded(async () => {
        const { watchlists } = await appGet<{ watchlists: Watchlist[] }>("/api/quant/watchlists");
        if (watchlists.length === 0) {
          return ok("The member has no watchlist yet. watchlists_create makes one.", { watchlists: [] });
        }
        const lines = watchlists.map((w) => {
          const symbols = w.symbols.map(rowWords);
          return `- "${w.name}" (id ${w.id}): ${w.symbols.length === 0 ? "empty" : `${w.symbols.length} symbol${w.symbols.length === 1 ? "" : "s"}: ${symbols.join(", ")}`}`;
        });
        return ok(`${watchlists.length} watchlist${watchlists.length === 1 ? "" : "s"}:\n${lines.join("\n")}`, {
          watchlists: watchlists.map((w) => ({
            id: w.id,
            name: w.name,
            updated_at: w.updatedAt,
            symbols: w.symbols.map(rowView),
          })),
        });
      }),
  );

  registerProtectedTool(
    server,
    runtime,
    "watchlists_create",
    {
      title: "Create a watchlist",
      description: `Creates a new watchlist in the signed-in member's account, optionally with its first symbols; it shows up in Vela on the web and in the Vela apps. Use watchlists_add_symbols to add to a list that exists. ${PLAN_NOTE} ${CONFIRM_NOTE}`,
      inputSchema: z.object({
        name: z.string().trim().min(1).max(200).describe("The list's name, e.g. \"Crypto majors\"."),
        symbols: marketsInput.optional(),
        etf: z.boolean().optional().describe("File the US listings among `symbols` under ETFs instead of Stocks."),
      }),
      annotations: WRITE,
    },
    async ({ name, symbols, etf }) =>
      guarded(async () => {
        const parsed = parseAll(symbols ?? []);
        if ("error" in parsed) return textError(parsed.error);
        const rows: WatchlistRow[] = [];
        const seen = new Set<string>();
        for (const market of parsed.markets) {
          if (seen.has(marketKey(market))) continue;
          seen.add(marketKey(market));
          const row = marketRow(market, { etf });
          if ("error" in row) return textError(`Nothing was saved: ${row.error}.`);
          rows.push(row);
        }
        const created = await appSend<{ created: boolean; id?: string; reason?: "invalid" | "limit" }>("POST", "/api/quant/watchlists", {
          body: { name, symbols: rows },
        });
        if (!created.created || !created.id) {
          return textError(`The watchlist was not created${created.reason === "invalid" ? ": the app refused its name or symbols" : ""}.`);
        }
        const what = rows.length ? ` with ${list(rows.map(rowWords))}` : ", empty";
        return ok(`Created the watchlist "${name}"${what}. Its id is ${created.id}. It shows in Vela on the web and in the Vela apps.`, {
          id: created.id,
          name,
          symbols: rows.map(rowView),
        });
      }),
  );

  registerProtectedTool(
    server,
    runtime,
    "watchlists_add_symbols",
    {
      title: "Add to a watchlist",
      description: `Adds markets to one of the signed-in member's watchlists (its id from watchlists_list), at the end of the list or in a named section; a market already in the list is left as it is. Returns the list as saved, in words, with a Vela chart link per added market. ${PLAN_NOTE} ${CONFIRM_NOTE}`,
      inputSchema: z.object({
        watchlist_id: watchlistIdInput,
        symbols: marketsInput,
        section: z.string().trim().min(1).max(80).optional().describe("A section of the list to put them in (the list's own groupings)."),
        etf: z.boolean().optional().describe("File the US listings among `symbols` under ETFs instead of Stocks."),
      }),
      annotations: WRITE,
    },
    async ({ watchlist_id, symbols, section, etf }) =>
      guarded(async () => {
        const parsed = parseAll(symbols);
        if ("error" in parsed) return textError(parsed.error);
        const newRows: WatchlistRow[] = [];
        for (const market of parsed.markets) {
          const row = marketRow(market, { etf, section });
          if ("error" in row) return textError(`Nothing was saved: ${row.error}.`);
          newRows.push(row);
        }
        const result = await editSymbols(watchlist_id, (current) => {
          const keys = new Set(current.symbols.map((row) => marketKey(rowMarket(row))));
          const added: WatchlistRow[] = [];
          const already: WatchlistRow[] = [];
          for (const row of newRows) {
            const key = marketKey(rowMarket(row));
            if (keys.has(key)) already.push(row);
            else {
              keys.add(key);
              added.push(row);
            }
          }
          return { rows: [...current.symbols, ...added], changed: added.length > 0, outcome: { added, already } };
        });
        if ("missing" in result) return MISSING(watchlist_id);
        if ("stale" in result) return STALE;
        const { watchlist, rows, outcome } = result;
        const parts: string[] = [];
        if (outcome.added.length) parts.push(`Added ${list(outcome.added.map(rowWords))} to "${watchlist.name}"`);
        if (outcome.already.length) parts.push(`${outcome.added.length ? "Already there" : `Nothing was added: "${watchlist.name}" already has`}: ${list(outcome.already.map(rowWords))}`);
        return ok(`${parts.join(". ")}. The list now has ${rows.length} symbol${rows.length === 1 ? "" : "s"}.`, {
          id: watchlist.id,
          name: watchlist.name,
          added: outcome.added.map(rowView),
          already_there: outcome.already.map(rowView),
          symbols: rows.map(rowView),
        });
      }),
  );

  registerProtectedTool(
    server,
    runtime,
    "watchlists_remove_symbols",
    {
      title: "Remove from a watchlist",
      description: `Removes markets from one of the signed-in member's watchlists (its id from watchlists_list). Name each one as watchlists_list shows it (source:TICKER) or by its bare symbol ("AAPL", "BTCUSD"), which removes every row of that symbol. The list itself stays; this server cannot delete a watchlist. Returns what was removed and what was not found. ${CONFIRM_NOTE}`,
      inputSchema: z.object({
        watchlist_id: watchlistIdInput,
        symbols: z
          .array(z.string().min(1).max(60))
          .min(1)
          .max(50)
          .describe('Markets to remove: "binance:BTCUSDT", or a bare symbol such as "AAPL".'),
      }),
      // Removing a row cannot be undone except by adding it again.
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ watchlist_id, symbols }) =>
      guarded(async () => {
        const matches = (row: WatchlistRow, input: string): boolean => {
          const typed = input.trim();
          if (typed.includes(":")) {
            const parsed = parseMarketInput(typed);
            return !("error" in parsed) && marketKey(parsed) === marketKey(rowMarket(row));
          }
          const upper = typed.toUpperCase();
          return row.symbol.toUpperCase() === upper || rowMarket(row).symbol.toUpperCase() === upper;
        };
        const result = await editSymbols(watchlist_id, (current) => {
          const removed = current.symbols.filter((row) => symbols.some((input) => matches(row, input)));
          const notFound = symbols.filter((input) => !current.symbols.some((row) => matches(row, input)));
          return {
            rows: current.symbols.filter((row) => !removed.includes(row)),
            changed: removed.length > 0,
            outcome: { removed, notFound },
          };
        });
        if ("missing" in result) return MISSING(watchlist_id);
        if ("stale" in result) return STALE;
        const { watchlist, rows, outcome } = result;
        const parts: string[] = [];
        parts.push(
          outcome.removed.length
            ? `Removed ${list(outcome.removed.map(rowWords))} from "${watchlist.name}"`
            : `Nothing was removed from "${watchlist.name}"`,
        );
        if (outcome.notFound.length) parts.push(`Not in the list: ${list(outcome.notFound)}`);
        return ok(`${parts.join(". ")}. The list now has ${rows.length} symbol${rows.length === 1 ? "" : "s"}.`, {
          id: watchlist.id,
          name: watchlist.name,
          removed: outcome.removed.map(rowView),
          not_found: outcome.notFound,
          symbols: rows.map(rowView),
        });
      }),
  );
}

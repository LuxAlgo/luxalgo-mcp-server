/*
  Trade Journal tools — the signed-in user's own journal in the LuxAlgo app:
  accounts, the dashboard, the calendar, trades with their fills and
  annotations, day notes, and the writes that keep a journal alive (logging
  fills by hand, annotating trades, writing notes).

  Every route here needs a user, so every tool is protected: the caller meets
  the sign-in challenge before a wasted round-trip. Nothing about
  entitlements is decided here — the app owns the data and the rules; these
  tools forward the user's token and relay its answers (docs/auth.md §1).

  Conventions the app fixes and the tools inherit: dates are YYYY-MM-DD day
  keys in the user's journal timezone (journal_list_accounts tells which);
  account filters are ids and unknown ids are rejected, not ignored; a trade
  is derived from its fills, and its `key` is the handle every per-trade
  tool takes. Writes go through appSend, always as the user.
*/
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerProtectedTool } from "../../auth/protected-tool.js";
import type { AuthRuntime } from "../../auth/runtime.js";
import { AppAuthError, AppPermissionError } from "../../platform/app-client.js";
import { errorMessage, guarded, json, toolError } from "../_shared/result.js";
import {
  addExecutions,
  annotateTrade,
  createNote,
  getBreakdown,
  getCalendar,
  getDay,
  getJournalBoot,
  getOverview,
  getTrade,
  getVocabulary,
  listTrades,
  searchNotes,
  TRADE_SORT_FIELDS,
  updateNote,
  type JournalBoot,
  type JournalTradeSummary,
  type TradeAnnotationsPatch,
} from "./api.js";

const APP_URL = "https://app.luxalgo.com";
const NO_ACCOUNTS_NOTE = `No journal accounts yet. Trades enter the journal by broker sync, statement import or manual entry in the LuxAlgo app (${APP_URL}); journal_add_trade can log fills once a manual account exists.`;

// ── shared input pieces ─────────────────────────────────────────────────────

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

const dayKey = (what: string) => z.string().regex(DAY_KEY, "YYYY-MM-DD").describe(what);

const accountsInput = z
  .array(z.string().min(1))
  .min(1)
  .max(50)
  .optional()
  .describe(
    "Journal account ids to scope to (from journal_list_accounts). Omit for every account, archived ones included. Unknown ids are rejected.",
  );

const rangeInput = z
  .enum(["today", "7d", "30d", "90d", "365d", "ytd", "all"])
  .optional()
  .describe("Named window ending today in the journal timezone. Ignored when from/to are given.");

const fromInput = dayKey("Inclusive start day (YYYY-MM-DD, journal timezone). Overrides `range`.").optional();
const toInput = dayKey("Inclusive end day (YYYY-MM-DD, journal timezone). Overrides `range`.").optional();

const tradeKeyInput = z
  .string()
  .min(1)
  .describe(
    "The trade's `key` exactly as returned by journal_list_trades, journal_get_day, journal_search_notes or journal_add_trade. Never construct one.",
  );

const cursorInput = z
  .string()
  .min(1)
  .optional()
  .describe("`nextCursor` from the previous page; keep every other argument identical.");

const listInput = (what: string, max: number) =>
  z.array(z.string().trim().min(1).max(max)).max(20).optional().describe(what);

const fillInput = z.object({
  symbol: z.string().trim().min(1).max(30).describe("Ticker as the user names it, e.g. 'AAPL', 'ES', 'BTCUSDT'."),
  side: z.enum(["buy", "sell"]),
  quantity: z.number().positive().finite().describe("Units, shares or contracts filled — always positive; `side` carries the direction."),
  price: z.number().nonnegative().finite().describe("Fill price per unit."),
  fee: z.number().nonnegative().finite().optional().describe("Commission and fees for this fill, in the account currency. Default 0."),
  executedAt: z
    .string()
    .min(1)
    .describe("When the fill happened — ISO 8601 with a UTC offset, e.g. '2026-09-08T13:35:00-04:00'. Order among fills follows this."),
  assetClass: z.enum(["equity", "option", "futures", "forex", "crypto", "cfd", "other"]).optional(),
});

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * The journal timezone. The boot call states it (`timeZone`); on app builds
 * that predate the field, fall back to the stored setting and then to UTC,
 * which is the app's own default when the user never chose one.
 */
const journalTimeZone = (boot: JournalBoot): string => boot.timeZone ?? boot.settings?.timezone ?? "UTC";

/** The current YYYY-MM in a timezone (a bad zone name throws a RangeError → tool error). */
function currentMonthKey(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}`;
}

/**
 * Add/remove on a free-form word list, keeping the user's existing casing:
 * an `add` that matches an existing entry case-insensitively is a no-op, a
 * `remove` matches case-insensitively too. Order of the existing list is kept.
 */
function mergeWords(current: string[], add: string[] = [], remove: string[] = []): string[] {
  const out = [...current];
  for (const raw of add) {
    const word = raw.trim();
    if (word && !out.some((existing) => existing.toLowerCase() === word.toLowerCase())) out.push(word);
  }
  const drop = new Set(remove.map((word) => word.trim().toLowerCase()));
  return out.filter((word) => !drop.has(word.toLowerCase()));
}

/** Trades of `accountId` on `symbols` whose span overlaps [fromMs, toMs] — where fresh fills landed. */
async function tradesTouching(accountId: string, symbols: string[], fromMs: number, toMs: number): Promise<JournalTradeSummary[]> {
  const pages = await Promise.all(symbols.map((symbol) => listTrades({ accounts: [accountId], symbol, limit: 50 })));
  return pages
    .flatMap((page) => page.trades)
    .filter((trade) => Date.parse(trade.openedAt) <= toMs && (trade.closedAt === null || Date.parse(trade.closedAt) >= fromMs));
}

// ── registration ────────────────────────────────────────────────────────────

export function registerJournalTools(server: McpServer, runtime: AuthRuntime) {
  registerProtectedTool(
    server,
    runtime,
    "journal_list_accounts",
    {
      title: "List journal accounts",
      description:
        "The signed-in user's trade-journal accounts — id, name, broker, kind (`sync` mirrors a live broker connection, `import` came from statements, `manual` is hand-entered), currency, initial balance, P&L lot method, last broker sync, archived state — plus `timeZone`, the journal timezone every date in the journal tools is expressed in. Call this first: every other journal tool's `accounts` filter takes these ids and rejects unknown ones, and journal_add_trade needs a `manual` or `import` account. An empty list means no journal yet.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guarded(async () => {
        const boot = await getJournalBoot();
        return json({
          asOf: boot.asOf,
          timeZone: journalTimeZone(boot),
          accounts: boot.accounts,
          settings: boot.settings,
          ...(boot.accounts.length === 0 ? { note: NO_ACCOUNTS_NOTE } : {}),
        });
      }),
  );

  registerProtectedTool(
    server,
    runtime,
    "journal_overview",
    {
      title: "Journal dashboard",
      description:
        "The journal dashboard in one call for a window: performance metrics (net/gross P&L, fees, win rate, day win rate, profit factor, expectancy, average win/loss and their ratio, largest win/loss, streaks, max drawdown, recovery factor, profit concentration, average realized R), the Edge Score with its six components, per-day P&L stats, the cumulative equity curve, open positions, and the accounts and settings the numbers cover. Closed trades bucket by close day in the journal timezone; open positions count toward any window that reaches today. `compare: true` adds `previous` — the equal-length window just before. Defaults to the last 30 days; pass `range: 'all'` or explicit `from`/`to` for more. Null metrics are not computable yet (e.g. no losses → `profitFactorIsInfinite`). Use journal_breakdown for where the P&L comes from and journal_list_trades for the trades themselves.",
      inputSchema: z.object({
        range: rangeInput,
        from: fromInput,
        to: toInput,
        accounts: accountsInput,
        compare: z.boolean().optional().describe("Also compute the equal-length window immediately before this one."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ range, from, to, accounts, compare }) =>
      guarded(async () => {
        const effectiveRange = range ?? (from || to ? undefined : "30d");
        const [overview, boot] = await Promise.all([
          getOverview({ range: effectiveRange, from, to, accounts, compare }),
          getJournalBoot(),
        ]);
        const scope = new Set(accounts ?? []);
        return json({
          ...overview,
          accounts: scope.size > 0 ? boot.accounts.filter((account) => scope.has(account.id)) : boot.accounts,
          settings: boot.settings,
          ...(boot.accounts.length === 0 ? { note: NO_ACCOUNTS_NOTE } : {}),
        });
      }),
  );

  registerProtectedTool(
    server,
    runtime,
    "journal_calendar",
    {
      title: "Journal P&L calendar",
      description:
        "One month of the P&L calendar: week rows of day cells (net and gross P&L, fees, trade/win/loss/breakeven counts, volume; null for days with no trades), each week's net P&L and trade count, and the month's net P&L, trade count, trading days and winning days. Days are in the journal timezone. Omit `month` for the current month. Drill into one day with journal_get_day.",
      inputSchema: z.object({
        month: z
          .string()
          .regex(/^\d{4}-\d{2}$/, "YYYY-MM")
          .optional()
          .describe("Month as YYYY-MM. Default: the current month in the journal timezone."),
        accounts: accountsInput,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ month, accounts }) =>
      guarded(async () => {
        const monthKey = month ?? currentMonthKey(journalTimeZone(await getJournalBoot()));
        return json(await getCalendar({ month: monthKey, accounts }));
      }),
  );

  registerProtectedTool(
    server,
    runtime,
    "journal_breakdown",
    {
      title: "Journal P&L breakdown",
      description:
        "Where the P&L actually comes from: closed trades in the window grouped nine ways — weekday, time of day, hold time, symbol, side, position size, tag, rating and asset class — each group with trade count, wins, losses, net P&L, average net P&L and win rate (breakevens excluded). Defaults to all time, since groups need sample size; narrow with `range` or `from`/`to`. The tool for 'what am I good or bad at' questions; journal_overview has the headline numbers.",
      inputSchema: z.object({ range: rangeInput, from: fromInput, to: toInput, accounts: accountsInput }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ range, from, to, accounts }) => guarded(async () => json(await getBreakdown({ range, from, to, accounts }))),
  );

  registerProtectedTool(
    server,
    runtime,
    "journal_list_trades",
    {
      title: "List journal trades",
      description:
        "Trade summaries — `key`, account, symbol, asset class, direction, status (open/win/loss/breakeven), open and close times, quantity and open quantity, average entry/exit, gross and net P&L, fees, fill count, duration, realized R, tags, rating, reviewed flag, hasNotes — newest-opened first by default. `sort` orders by any of openedAt, closedAt, netPnl, grossPnl, durationMs, quantity, symbol or rating (names match the response fields); `order` is desc unless set, except symbol which defaults to asc. Trades lacking the sort value (open trades for closedAt/durationMs, unrated for rating) come last in either order; netPnl is after fees, grossPnl before. Filter by account ids, open-day window (`from`/`to` are inclusive YYYY-MM-DD day keys in the journal timezone, applied to the trade's open day; open positions are always listed), symbol, direction, status or one exact tag. Keyset-paginated: pass `nextCursor` back as `cursor` with the same sort, order and filters. Examples: biggest winners this month = from/to + sort netPnl; worst by gross = sort grossPnl, order asc, status loss; longest holds = sort durationMs. Summaries carry no fills or note text: journal_get_trade with the `key` has those.",
      inputSchema: z.object({
        accounts: accountsInput,
        from: fromInput,
        to: toInput,
        symbol: z.string().trim().min(1).max(30).optional().describe("One symbol, e.g. 'AAPL' (case-insensitive)."),
        direction: z.enum(["long", "short"]).optional(),
        status: z.enum(["open", "win", "loss", "breakeven"]).optional(),
        tag: z.string().trim().min(1).max(40).optional().describe("Trades carrying exactly this tag (see journal_list_tags)."),
        sort: z
          .enum(TRADE_SORT_FIELDS)
          .optional()
          .describe("Field to order by; default openedAt. Trades without a value for it come last in either order."),
        order: z
          .enum(["asc", "desc"])
          .optional()
          .describe("Default desc (largest / latest first); symbol defaults to asc (A→Z)."),
        limit: z.number().int().min(1).max(100).optional().describe("Page size, default 25."),
        cursor: cursorInput,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => guarded(async () => json(await listTrades({ ...args, limit: args.limit ?? 25 }))),
  );

  registerProtectedTool(
    server,
    runtime,
    "journal_get_trade",
    {
      title: "Get one journal trade",
      description:
        "One trade in full: the summary fields plus its fills (each with the effective values, what the source reported, the user's corrections and whether it is hidden), per-exit gross P&L, hidden fills inside the trade's span, and every annotation — notes, tags, mistakes, playbook id, stop loss, profit target, review time. Use after journal_list_trades or journal_get_day when the user asks about a specific trade or before annotating it.",
      inputSchema: z.object({ key: tradeKeyInput }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ key }) => guarded(async () => json({ trade: await getTrade(key) })),
  );

  registerProtectedTool(
    server,
    runtime,
    "journal_get_day",
    {
      title: "Get one journal day",
      description:
        "A single trading day: its stats (null when nothing traded), its trades (closed that day, or opened that day and still open) as summaries, and the day's notes with their ids. `date` is a YYYY-MM-DD day key in the journal timezone. Use it for 'how did Tuesday go', and to find note ids for journal_update_note.",
      inputSchema: z.object({ date: dayKey("The day, YYYY-MM-DD in the journal timezone."), accounts: accountsInput }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ date, accounts }) => guarded(async () => json(await getDay(date, accounts))),
  );

  registerProtectedTool(
    server,
    runtime,
    "journal_list_tags",
    {
      title: "List journal tags, mistakes and playbooks",
      description:
        "The user's annotation vocabulary: every tag, mistake and playbook id they have put on any trade (open or closed), most-used first with the number of trades carrying each. Check it before journal_update_trade so new annotations reuse the user's own words instead of minting near-duplicates. Per-trade tags are on each trade summary, not here.",
      inputSchema: z.object({ accounts: accountsInput }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ accounts }) => guarded(async () => json(await getVocabulary(accounts))),
  );

  registerProtectedTool(
    server,
    runtime,
    "journal_search_notes",
    {
      title: "Search journal notes",
      description:
        "Search the notes feed — day notes and trades that carry notes — newest first as one stream split by kind: `notes` (day notes, with ids for journal_update_note) and `tradeNotes` (the trade summary with its note text; annotate via journal_update_trade). Filter by case-insensitive text (`q`), day-key window, symbol (trade notes only — day notes have no symbol and drop out) and account ids; keyset-paginated via `cursor`/`nextCursor`. Omit every filter for the latest notes.",
      inputSchema: z.object({
        q: z.string().trim().min(1).max(200).optional().describe("Substring to look for in note text, case-insensitive."),
        from: fromInput,
        to: toInput,
        symbol: z.string().trim().min(1).max(30).optional(),
        accounts: accountsInput,
        limit: z.number().int().min(1).max(100).optional().describe("Page size, default 25."),
        cursor: cursorInput,
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => guarded(async () => json(await searchNotes({ ...args, limit: args.limit ?? 25 }))),
  );

  // ── writes ────────────────────────────────────────────────────────────────

  registerProtectedTool(
    server,
    runtime,
    "journal_add_trade",
    {
      title: "Log a trade by hand",
      description:
        "Log a trade by adding its fills to a `manual` or `import` journal account (never a broker-synced one — the sync owns those). The journal derives trades from fills: a long round trip is a buy fill then a sell fill, a short is sell then buy, scale-ins and partial exits are just more fills, and a lone fill opens a position. Times are ISO 8601 instants with offset; fees are per fill. Fills identical to existing ones are skipped as duplicates. Returns the insert counts and the trade(s) the fills now belong to, with `key`s for journal_update_trade. Correcting or removing an existing fill is done in the app, not here.",
      inputSchema: z.object({
        accountId: z.string().min(1).describe("A `manual` or `import` account id from journal_list_accounts."),
        fills: z.array(fillInput).min(1).max(100).describe("The fills, in any order."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ accountId, fills }) =>
      guarded(async () => {
        const result = await addExecutions(accountId, fills);
        const times = fills.map((fill) => Date.parse(fill.executedAt)).filter(Number.isFinite);
        const symbols = [...new Set(fills.map((fill) => fill.symbol.trim().toUpperCase()))];
        let trades: JournalTradeSummary[] = [];
        let lookup: string | undefined;
        try {
          trades = await tradesTouching(accountId, symbols, Math.min(...times), Math.max(...times));
        } catch (error) {
          if (error instanceof AppAuthError || error instanceof AppPermissionError) throw error;
          lookup = `fills saved, but looking up the resulting trades failed: ${errorMessage(error)}`;
        }
        return json({
          ...result,
          trades,
          ...(result.inserted === 0 && result.duplicates > 0
            ? { note: "Every fill already existed in this account — nothing new was recorded." }
            : {}),
          ...(lookup ? { note: lookup } : {}),
        });
      }),
  );

  registerProtectedTool(
    server,
    runtime,
    "journal_update_trade",
    {
      title: "Annotate a journal trade",
      description:
        "Annotate a trade — the user-owned fields only: `notes` (free text about this trade), `tags`, `mistakes`, `playbookId`, `rating` 1–5, `stopLoss` and `profitTarget` (price levels; the stop is what realized R is measured against) and `reviewed`. `tags`/`mistakes` replace the whole list; use `addTags`/`removeTags`/`addMistakes`/`removeMistakes` to change a few entries without clobbering the rest (check journal_list_tags for the user's existing words). Pass null to clear a field. Does not touch fills, prices or P&L — those derive from the fills. Returns the updated trade in full.",
      inputSchema: z.object({
        key: tradeKeyInput,
        notes: z.string().max(20_000).nullable().optional().describe("Replaces the trade's note text; null clears it."),
        tags: listInput("Replace the whole tag list; null clears it. Not with addTags/removeTags.", 40).nullable(),
        addTags: listInput("Tags to add (existing ones are kept; case-insensitive duplicates are ignored).", 40),
        removeTags: listInput("Tags to remove (case-insensitive).", 40),
        mistakes: listInput("Replace the whole mistakes list; null clears it. Not with addMistakes/removeMistakes.", 80).nullable(),
        addMistakes: listInput("Mistakes to add.", 80),
        removeMistakes: listInput("Mistakes to remove (case-insensitive).", 80),
        playbookId: z.string().trim().max(100).nullable().optional().describe("Playbook / setup name this trade followed; null clears it."),
        rating: z.number().int().min(1).max(5).nullable().optional().describe("Execution quality 1–5; null clears it."),
        stopLoss: z.number().finite().nullable().optional().describe("Planned stop price; null clears it."),
        profitTarget: z.number().finite().nullable().optional().describe("Planned target price; null clears it."),
        reviewed: z.boolean().optional().describe("Mark the trade reviewed (true) or not (false)."),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      guarded(async () => {
        if (args.tags !== undefined && (args.addTags || args.removeTags)) {
          return toolError("Pass either `tags` (replace) or `addTags`/`removeTags` (adjust), not both.");
        }
        if (args.mistakes !== undefined && (args.addMistakes || args.removeMistakes)) {
          return toolError("Pass either `mistakes` (replace) or `addMistakes`/`removeMistakes` (adjust), not both.");
        }

        const patch: TradeAnnotationsPatch = {};
        if (args.notes !== undefined) patch.notes = args.notes;
        if (args.tags !== undefined) patch.tags = args.tags;
        if (args.mistakes !== undefined) patch.mistakes = args.mistakes;
        if (args.playbookId !== undefined) patch.playbookId = args.playbookId;
        if (args.rating !== undefined) patch.rating = args.rating;
        if (args.stopLoss !== undefined) patch.stopLoss = args.stopLoss;
        if (args.profitTarget !== undefined) patch.profitTarget = args.profitTarget;
        if (args.reviewed !== undefined) patch.reviewed = args.reviewed;

        const adjustsTags = Boolean(args.addTags || args.removeTags);
        const adjustsMistakes = Boolean(args.addMistakes || args.removeMistakes);
        if (adjustsTags || adjustsMistakes) {
          // Read-merge-write: the app's list fields replace wholesale, so the
          // current lists are fetched first and the user's other entries kept.
          const current = await getTrade(args.key);
          if (adjustsTags) patch.tags = mergeWords(current.tags, args.addTags, args.removeTags);
          if (adjustsMistakes) patch.mistakes = mergeWords(current.mistakes, args.addMistakes, args.removeMistakes);
        }

        if (Object.keys(patch).length === 0) {
          return toolError("Nothing to update — pass at least one annotation field.");
        }
        return json({ trade: await annotateTrade(args.key, patch) });
      }),
  );

  registerProtectedTool(
    server,
    runtime,
    "journal_write_note",
    {
      title: "Write a journal note",
      description:
        "Add a new note to a trading day — any day, traded or not; `date` is YYYY-MM-DD in the journal timezone. Days hold any number of notes, so this never overwrites: to change an existing note use journal_update_note, and for a note about one specific trade use journal_update_trade's `notes`. Returns the note with its id.",
      inputSchema: z.object({
        date: dayKey("The day the note belongs to, YYYY-MM-DD in the journal timezone."),
        body: z.string().trim().min(1).max(50_000).describe("The note text (plain text or markdown)."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ date, body }) => guarded(async () => json({ note: await createNote(date, body) })),
  );

  registerProtectedTool(
    server,
    runtime,
    "journal_update_note",
    {
      title: "Update a journal note",
      description:
        "Replace a day note's text and/or move it to another day, by note id (from journal_get_day or journal_search_notes). The body is replaced whole — to append, read the current text first and send the full new version. Trade notes are edited with journal_update_trade, not here. Returns the updated note.",
      inputSchema: z.object({
        noteId: z.string().min(1).describe("The note's `id`."),
        body: z.string().trim().min(1).max(50_000).optional().describe("The full new text."),
        date: dayKey("Move the note to this day, YYYY-MM-DD in the journal timezone.").optional(),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ noteId, body, date }) =>
      guarded(async () => {
        if (body === undefined && date === undefined) return toolError("Nothing to update — pass `body`, `date` or both.");
        return json({ note: await updateNote(noteId, { body, date }) });
      }),
  );
}

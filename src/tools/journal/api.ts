/*
  Typed wrappers over the app's journal routes (`/api/journal/*`). Every one
  of them requires a signed-in user on the app side, so the tools in this
  domain are all protected; the token travels ambiently (auth/access-context.ts)
  and the app is the only place that decides what the user may read or
  write. Shapes below mirror the app's wire contracts field for field
  (app: src/app/api/journal/_contract.ts) — the app serialises them for the
  journal widget and for these tools alike, so nothing is reshaped here.

  Windows are day keys (YYYY-MM-DD) in the user's journal timezone on every
  route; account filters are ids and the app rejects unknown ones (400)
  rather than ignoring them.
*/
import { appGet, appSend } from "../../platform/app-client.js";

export type JournalRange = "today" | "7d" | "30d" | "90d" | "365d" | "ytd" | "all";

export type JournalAccount = {
  id: string;
  name: string;
  broker: string;
  kind: "import" | "manual" | "sync";
  currency: string;
  initialBalance: number;
  profitCalcMethod: "fifo" | "lifo" | "wavg";
  linked: boolean;
  lastSyncedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
};

export type JournalBoot = {
  available: boolean;
  asOf: string;
  /** The effective journal timezone (IANA). Absent on app builds that predate the field — see journalTimeZone in tools.ts. */
  timeZone?: string;
  accounts: JournalAccount[];
  settings: { timezone: string } | null;
};

export type JournalExecution = {
  id: string;
  accountId: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  fee: number;
  executedAt: string;
  assetClass: string | null;
  source: "import" | "manual" | "sync";
  reported: { side: "buy" | "sell"; quantity: number; price: number; fee: number; executedAt: string };
  overrides: Partial<{ side: "buy" | "sell"; quantity: number; price: number; fee: number; executedAt: string }> | null;
  excludedAt: string | null;
};

export type JournalTradeSummary = {
  key: string;
  accountId: string;
  symbol: string;
  assetClass: string | null;
  direction: "long" | "short";
  status: "open" | "win" | "loss" | "breakeven";
  openedAt: string;
  closedAt: string | null;
  quantity: number;
  openQuantity: number;
  avgEntry: number;
  avgExit: number | null;
  grossPnl: number;
  fees: number;
  netPnl: number;
  executionCount: number;
  durationMs: number | null;
  realizedR: number | null;
  tags: string[];
  rating: number | null;
  reviewed: boolean;
  hasNotes: boolean;
};

export type JournalTradeFull = JournalTradeSummary & {
  exits: Array<{ executionId: string; grossPnl: number; quantity: number }>;
  notes: string | null;
  mistakes: string[];
  playbookId: string | null;
  stopLoss: number | null;
  profitTarget: number | null;
  reviewedAt: string | null;
  executions: JournalExecution[];
  hiddenExecutions: JournalExecution[];
};

export type JournalNote = { id: string; date: string; body: string; createdAt: string; updatedAt: string };

export type JournalOverview = {
  asOf: string;
  timeZone: string;
  range: { from: string | null; to: string | null };
  metrics: Record<string, unknown>;
  edgeScore: Record<string, unknown>;
  days: Array<Record<string, unknown>>;
  equity: Array<{ t: string; cumNetPnl: number }>;
  openPositions: JournalTradeSummary[];
  previous: Record<string, unknown> | null;
};

export type JournalCalendar = { asOf: string; timeZone: string; calendar: Record<string, unknown> };

export type JournalBreakdown = Record<string, unknown> & { asOf: string; timeZone: string; closedTrades: number };

export type JournalTradesPage = {
  asOf: string;
  timeZone: string;
  trades: JournalTradeSummary[];
  nextCursor: string | null;
};

export type JournalDay = {
  asOf: string;
  timeZone: string;
  date: string;
  stats: Record<string, unknown> | null;
  trades: JournalTradeSummary[];
  notes: JournalNote[];
};

export type JournalVocabulary = {
  asOf: string;
  tags: Array<{ name: string; trades: number }>;
  mistakes: Array<{ name: string; trades: number }>;
  playbooks: Array<{ id: string; trades: number }>;
};

export type JournalNotesPage = {
  asOf: string;
  timeZone: string;
  notes: JournalNote[];
  tradeNotes: Array<{ date: string; trade: JournalTradeSummary; notes: string }>;
  nextCursor: string | null;
};

export type JournalFill = {
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  fee?: number;
  executedAt: string;
  assetClass?: "equity" | "option" | "futures" | "forex" | "crypto" | "cfd" | "other";
};

export type JournalIngestResult = { inserted: number; duplicates: number; skipped: number };

export type TradeAnnotationsPatch = {
  notes?: string | null;
  tags?: string[] | null;
  mistakes?: string[] | null;
  playbookId?: string | null;
  rating?: number | null;
  stopLoss?: number | null;
  profitTarget?: number | null;
  reviewed?: boolean;
};

type RangeQuery = { range?: JournalRange; from?: string; to?: string; accounts?: string[] };

/** The query layer is string-valued: account ids travel comma-separated. */
const accountsParam = (accounts?: string[]): string | undefined =>
  accounts && accounts.length > 0 ? accounts.join(",") : undefined;

const numParam = (value?: number): string | undefined => (value === undefined ? undefined : String(value));

export const getJournalBoot = () => appGet<JournalBoot>("/api/journal");

export const getOverview = (query: RangeQuery & { compare?: boolean }) =>
  appGet<JournalOverview>("/api/journal/overview", {
    range: query.range,
    from: query.from,
    to: query.to,
    accounts: accountsParam(query.accounts),
    compare: query.compare ? "previous" : undefined,
  });

export const getCalendar = (query: { month: string; accounts?: string[] }) =>
  appGet<JournalCalendar>("/api/journal/calendar", { month: query.month, accounts: accountsParam(query.accounts) });

export const getBreakdown = (query: RangeQuery) =>
  appGet<JournalBreakdown>("/api/journal/breakdown", {
    range: query.range,
    from: query.from,
    to: query.to,
    accounts: accountsParam(query.accounts),
  });

export const listTrades = (query: {
  accounts?: string[];
  from?: string;
  to?: string;
  symbol?: string;
  direction?: "long" | "short";
  status?: "open" | "win" | "loss" | "breakeven";
  tag?: string;
  limit?: number;
  cursor?: string;
}) =>
  appGet<JournalTradesPage>("/api/journal/trades", {
    accounts: accountsParam(query.accounts),
    from: query.from,
    to: query.to,
    symbol: query.symbol,
    direction: query.direction,
    status: query.status,
    tag: query.tag,
    limit: numParam(query.limit),
    cursor: query.cursor,
  });

export const getTrade = async (key: string) => (await appGet<{ trade: JournalTradeFull }>("/api/journal/trade", { key })).trade;

export const getDay = (date: string, accounts?: string[]) =>
  appGet<JournalDay>(`/api/journal/days/${encodeURIComponent(date)}`, { accounts: accountsParam(accounts) });

export const getVocabulary = (accounts?: string[]) =>
  appGet<JournalVocabulary>("/api/journal/tags", { accounts: accountsParam(accounts) });

export const searchNotes = (query: {
  q?: string;
  from?: string;
  to?: string;
  symbol?: string;
  accounts?: string[];
  limit?: number;
  cursor?: string;
}) =>
  appGet<JournalNotesPage>("/api/journal/notes", {
    q: query.q,
    from: query.from,
    to: query.to,
    symbol: query.symbol,
    accounts: accountsParam(query.accounts),
    limit: numParam(query.limit),
    cursor: query.cursor,
  });

// ── writes — always as the signed-in user ───────────────────────────────────

export const addExecutions = (accountId: string, fills: JournalFill[]) =>
  appSend<JournalIngestResult>("POST", "/api/journal/executions", { body: { accountId, fills } });

export const annotateTrade = async (key: string, patch: TradeAnnotationsPatch) =>
  (await appSend<{ trade: JournalTradeFull }>("PATCH", "/api/journal/trade", { body: { key, ...patch } })).trade;

export const createNote = async (date: string, body: string) =>
  (await appSend<{ note: JournalNote }>("POST", "/api/journal/notes", { body: { date, body } })).note;

export const updateNote = async (noteId: string, patch: { body?: string; date?: string }) =>
  (
    await appSend<{ note: JournalNote }>("PATCH", `/api/journal/notes/${encodeURIComponent(noteId)}`, {
      body: patch,
    })
  ).note;

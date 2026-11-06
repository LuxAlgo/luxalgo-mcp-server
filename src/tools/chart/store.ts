/*
  Where chart_command leaves edits for an open chart and where the chart view
  (the iframe, through chart_sync) picks them up and reports back.

  SPIKE ONLY: this is an in-process Map. It works on the plain-Node entry
  (one long-lived process), but hosted entries build a server per request and
  Vercel runs many instances, so chart_command and the view's chart_sync can
  land on different processes. Before this ships the store must move to a
  shared store (Redis/KV keyed by chart_id, with a TTL), and the wait in
  chart_command must become a poll of that store (or a pub/sub wake-up).

  Nothing here is user data: chart ids are random, ops are what the model
  asked for, and the view reports words-level state (symbol, timeframe, dates,
  indicator and drawing names) — never bars or exchange prices.
*/
import { randomBytes } from "node:crypto";

export type ChartOp =
  | { op: "set_market"; symbol?: string; timeframe?: string }
  | { op: "add_indicator"; name: string }
  | { op: "remove_indicator"; name: string }
  | { op: "add_level"; price: number; label?: string }
  | { op: "add_zone"; low: number; high: number; label?: string }
  | { op: "clear_drawings" }
  | { op: "zoom"; range: string };

export type SequencedOp = ChartOp & { seq: number };

/** What the view reports about itself. Words-level only. */
export type ViewState = {
  symbol?: string;
  timeframe?: string;
  range?: { from: string; to: string };
  indicators?: string[];
  levels?: Array<{ price: number; label?: string }>;
  zones?: Array<{ low: number; high: number; label?: string }>;
  other_drawings?: number;
  theme?: string;
  display_mode?: string;
  candles_loaded?: boolean;
  error?: string;
};

type ChartSession = {
  createdAt: number;
  ops: SequencedOp[];
  ackedSeq: number;
  view?: ViewState;
  lastSyncAt?: number;
};

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CHARTS = 5_000;
const MAX_OPS = 500;
const sessions = new Map<string, ChartSession>();

function sweep(now = Date.now()): void {
  for (const [id, session] of sessions) {
    if (now - (session.lastSyncAt ?? session.createdAt) > TTL_MS) sessions.delete(id);
  }
  while (sessions.size > MAX_CHARTS) sessions.delete(sessions.keys().next().value as string);
}

export function createChart(): string {
  sweep();
  const id = `ch_${randomBytes(9).toString("base64url")}`;
  sessions.set(id, { createdAt: Date.now(), ops: [], ackedSeq: 0 });
  return id;
}

export function hasChart(id: string): boolean {
  return sessions.has(id);
}

/** Appends ops; returns the sequence number of the last one. */
export function pushOps(id: string, ops: ChartOp[]): number | null {
  const session = sessions.get(id);
  if (!session) return null;
  let seq = session.ops.at(-1)?.seq ?? 0;
  for (const op of ops) session.ops.push({ ...op, seq: ++seq });
  if (session.ops.length > MAX_OPS) session.ops.splice(0, session.ops.length - MAX_OPS);
  return seq;
}

/** The view's poll: records its ack and state, returns the ops it has not applied yet. */
export function syncChart(id: string, ackedSeq: number, view: ViewState | undefined): { ops: SequencedOp[] } | null {
  const session = sessions.get(id);
  if (!session) return null;
  session.lastSyncAt = Date.now();
  session.ackedSeq = Math.max(session.ackedSeq, ackedSeq);
  if (view) session.view = view;
  return { ops: session.ops.filter((op) => op.seq > ackedSeq) };
}

export function chartStatus(id: string): { ackedSeq: number; view?: ViewState; lastSyncAt?: number } | null {
  const session = sessions.get(id);
  return session ? { ackedSeq: session.ackedSeq, view: session.view, lastSyncAt: session.lastSyncAt } : null;
}

/** Resolves once the view acknowledged `seq`, or after `timeoutMs`. */
export async function waitForAck(id: string, seq: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = chartStatus(id);
    if (!status) return false;
    if (status.ackedSeq >= seq) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return (chartStatus(id)?.ackedSeq ?? 0) >= seq;
}

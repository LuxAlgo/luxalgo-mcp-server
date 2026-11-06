/*
  Where chart_command leaves edits for an open chart and where the chart view
  (the iframe, through chart_sync) picks them up and reports back.

  Two backends behind one ChartStore interface (./backend.ts picks one per
  chart and marks it in the chart_id):

    app      the LuxAlgo app's chart sessions (./app-session.ts): shared by
             every server instance, and a Vela tab can follow the same chart;
    memory   this in-process Map, the fallback when the app does not offer
             chart sessions (it answers 404 while its flag is off) or cannot
             be reached. It works on the plain-Node entry (one long-lived
             process) but not across Vercel instances.

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

/** An op as the view receives it; `unsupported` stands in for one the view cannot apply (it acknowledges and skips it). */
export type SequencedOp = (ChartOp | { op: "unsupported" }) & { seq: number };

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

/** chart_command's outcome when queuing: the version of the last op, or why nothing was queued. */
export type PushResult = { version: number } | { gone: true } | { refused: string };

/** One open chart, wherever its edits live. */
export interface ChartStore {
  readonly backend: "app" | "memory";
  /** Queues ops in order (chart_command). */
  push(ops: ChartOp[]): Promise<PushResult>;
  /** Waits until the view acknowledged `version` (or `timeoutMs` passed); returns the latest report. */
  waitForAck(version: number, timeoutMs: number): Promise<{ applied: boolean; view?: ViewState }>;
  /** The view's poll (chart_sync): records its ack and state, returns the ops it has not applied yet; null when the chart is gone. */
  sync(ackedSeq: number, view: ViewState | undefined): Promise<{ ops: SequencedOp[] } | null>;
}

// ---------- memory backend ----------

type MemoryChart = {
  createdAt: number;
  ops: Array<ChartOp & { seq: number }>;
  ackedSeq: number;
  view?: ViewState;
  lastSyncAt?: number;
};

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CHARTS = 5_000;
const MAX_OPS = 500;
const charts = new Map<string, MemoryChart>();

function sweep(now = Date.now()): void {
  for (const [id, chart] of charts) {
    if (now - (chart.lastSyncAt ?? chart.createdAt) > TTL_MS) charts.delete(id);
  }
  while (charts.size > MAX_CHARTS) charts.delete(charts.keys().next().value as string);
}

/** A new in-memory chart; its id is the chart_id ("ch_…"). */
export function createMemoryChart(): string {
  sweep();
  const id = `ch_${randomBytes(9).toString("base64url")}`;
  charts.set(id, { createdAt: Date.now(), ops: [], ackedSeq: 0 });
  return id;
}

/** The store for an in-memory chart, or null when this process does not hold it. */
export function memoryStore(id: string): ChartStore | null {
  if (!charts.has(id)) return null;
  const chart = () => charts.get(id);
  return {
    backend: "memory",
    async push(ops) {
      const current = chart();
      if (!current) return { gone: true };
      let seq = current.ops.at(-1)?.seq ?? 0;
      for (const op of ops) current.ops.push({ ...op, seq: ++seq });
      if (current.ops.length > MAX_OPS) current.ops.splice(0, current.ops.length - MAX_OPS);
      return { version: seq };
    },
    async waitForAck(version, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while ((chart()?.ackedSeq ?? 0) < version && chart() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const current = chart();
      return { applied: (current?.ackedSeq ?? 0) >= version, view: current?.view };
    },
    async sync(ackedSeq, view) {
      const current = chart();
      if (!current) return null;
      current.lastSyncAt = Date.now();
      current.ackedSeq = Math.max(current.ackedSeq, ackedSeq);
      if (view) current.view = view;
      return { ops: current.ops.filter((op) => op.seq > ackedSeq) };
    },
  };
}

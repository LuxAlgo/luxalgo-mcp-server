/*
  What this server process keeps beside a chart's store, keyed by the store's
  key ("memory:<id>" or "app:<session id>"):

    numbers    the numbers the view last reported (./numbers.ts). An app
               session's state schema is words-only and strict, so they never
               go to the app; a chart kept in memory has them in its own state
               too.
    snapshot   a pending "send what the user sees to the model" request
               (chart_command's read op with image: true) and the view's
               answer to it.

  Process-local and short-lived. On a deployment with many instances, a
  chart_command served by another instance than the view's chart_sync does
  not see them: the reply is then words only, as before, and a snapshot
  request says it got no answer. Nothing here is user data: the numbers come
  from public exchange feeds (numbersAllowed markets only), and keys are
  random.
*/
import type { ChartNumbers } from "./numbers.js";

/** How long reported numbers count as live: the view reports about every second while it is on screen. */
export const NUMBERS_FRESH_MS = 30_000;
/** A snapshot request the view has not picked up by then is dropped: a chart shown later must not send a picture nobody waits for. */
const SNAPSHOT_REQUEST_MS = 15_000;

export type SnapshotOutcome =
  | { outcome: "sent"; width: number; height: number; bytes: number }
  | { outcome: "unsupported" | "words_only" | "failed"; reason?: string };

type Local = {
  touchedAt: number;
  numbers?: { values: ChartNumbers; symbol?: string; timeframe?: string; at: number };
  snapshot?: { id: number; at: number; answer?: SnapshotOutcome };
};

const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 5_000;
const entries = new Map<string, Local>();
let nextSnapshotId = 1;

function entry(key: string): Local {
  const now = Date.now();
  let found = entries.get(key);
  if (!found) {
    for (const [k, v] of entries) if (now - v.touchedAt > TTL_MS) entries.delete(k);
    while (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
    found = { touchedAt: now };
    entries.set(key, found);
  }
  found.touchedAt = now;
  return found;
}

/** Records (or, with undefined, clears) the numbers the view reported for the market it shows. */
export function rememberNumbers(key: string, values: ChartNumbers | undefined, market: { symbol?: string; timeframe?: string }): void {
  if (!values) {
    const found = entries.get(key);
    if (found) delete found.numbers;
    return;
  }
  entry(key).numbers = { values, symbol: market.symbol, timeframe: market.timeframe, at: Date.now() };
}

/** The view's numbers for this market, when reported in the last NUMBERS_FRESH_MS. */
export function freshNumbers(key: string, market: { symbol?: string; timeframe?: string }): ChartNumbers | undefined {
  const numbers = entries.get(key)?.numbers;
  if (!numbers || Date.now() - numbers.at > NUMBERS_FRESH_MS) return undefined;
  if (numbers.symbol !== market.symbol || numbers.timeframe !== market.timeframe) return undefined;
  return numbers.values;
}

/** Asks the view for a snapshot; returns the request's id (a newer request replaces an older one). */
export function requestSnapshot(key: string): number {
  const id = nextSnapshotId++;
  entry(key).snapshot = { id, at: Date.now() };
  return id;
}

/** The snapshot request the view has not answered yet, if any (chart_sync hands it to the view). */
export function pendingSnapshot(key: string): number | undefined {
  const snapshot = entries.get(key)?.snapshot;
  return snapshot && !snapshot.answer && Date.now() - snapshot.at <= SNAPSHOT_REQUEST_MS ? snapshot.id : undefined;
}

/** The view's answer to a snapshot request (from chart_sync). Answers to an older request are ignored. */
export function answerSnapshot(key: string, id: number, answer: SnapshotOutcome): void {
  const snapshot = entries.get(key)?.snapshot;
  if (snapshot && snapshot.id === id) snapshot.answer = answer;
}

/** Waits for the view's answer to request `id`, up to `timeoutMs`. */
export async function waitForSnapshot(key: string, id: number, timeoutMs: number): Promise<SnapshotOutcome | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = entries.get(key)?.snapshot;
    if (!snapshot || snapshot.id !== id) return undefined;
    if (snapshot.answer) return snapshot.answer;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

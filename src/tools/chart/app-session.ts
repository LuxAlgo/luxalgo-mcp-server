/*
  The app backend of the chart store: the LuxAlgo app's chart sessions.

    POST /api/chart-sessions                 create (anonymous, or as the caller) → {id, writeKey, readKey}
    POST /api/chart-sessions/{id}/commands   write key: {ops} → {version}; 409 for an op the chart cannot take
    GET  /api/chart-sessions/{id}?after=N    read or write key → {state, version, ackedVersion, pendingOps, …}
    POST /api/chart-sessions/{id}/state      read key: {ackedVersion, state?} → {ackedVersion}

  Every refusal is a 404, including when the app's chart sessions are switched
  off: creating one then answers 404 and ./backend.ts falls back to memory.
  The calls go through the narrow chart-session helpers in
  platform/app-client.ts (docs/auth.md §7a): the session key, never a user's
  token, authorises everything after the create. Keys are never logged.

  The app's state schema is strict and words-only, so the view's report is
  mapped onto it field by field and anything else (theme, display mode) is
  dropped here.
*/
import { z } from "zod";
import {
  AppApiError,
  AppAuthError,
  AppPermissionError,
  appGetChartSession,
  appSendChartSession,
} from "../../platform/app-client.js";
import { NATIVE_INDICATOR_KEYS, RANGE_PRESETS, TIMEFRAME_KEYS } from "./market.js";
import type { ChartOp, ChartStore, SequencedOp, ViewState } from "./store.js";

export const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const SESSION_KEY = /^[A-Za-z0-9_-]{8,128}$/;

export type AppSessionKeys = { id: string; writeKey: string; readKey: string };

const POLL_MS = 250;
const CREATE_TIMEOUT_MS = 4_000;

const base = (id: string) => `/api/chart-sessions/${id}`;

const isAuthError = (error: unknown) => error instanceof AppAuthError || error instanceof AppPermissionError;
const isStatus = (error: unknown, status: number) => error instanceof AppApiError && error.status === status;

/**
 * Creates a session in the app, as the caller when they signed in. Null when
 * the app does not offer chart sessions (404), cannot be reached, fails, or
 * answers in a shape we cannot use: the chart then lives in memory.
 */
export async function createAppSession(): Promise<AppSessionKeys | null> {
  try {
    const created = await appSendChartSession<Partial<AppSessionKeys>>("/api/chart-sessions", { timeoutMs: CREATE_TIMEOUT_MS });
    const { id, writeKey, readKey } = created ?? {};
    if (typeof id !== "string" || typeof writeKey !== "string" || typeof readKey !== "string") return null;
    if (!SESSION_ID.test(id) || !SESSION_KEY.test(writeKey) || !SESSION_KEY.test(readKey)) return null;
    return { id, writeKey, readKey };
  } catch (error) {
    if (isAuthError(error)) throw error;
    return null;
  }
}

/** The ops the view can apply; anything else the app hands back reaches the view as `unsupported`. */
const viewOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set_market"), symbol: z.string().max(60).optional(), timeframe: z.enum(TIMEFRAME_KEYS).optional() }),
  z.object({ op: z.literal("add_indicator"), name: z.enum(NATIVE_INDICATOR_KEYS) }),
  z.object({ op: z.literal("remove_indicator"), name: z.enum(NATIVE_INDICATOR_KEYS) }),
  z.object({ op: z.literal("add_level"), price: z.number().positive(), label: z.string().max(40).optional() }),
  z.object({ op: z.literal("add_zone"), low: z.number().positive(), high: z.number().positive(), label: z.string().max(40).optional() }),
  z.object({ op: z.literal("clear_drawings") }),
  z.object({ op: z.literal("zoom"), range: z.enum(RANGE_PRESETS) }),
]);

function toViewOp(pending: unknown): SequencedOp | null {
  if (!pending || typeof pending !== "object") return null;
  const version = (pending as { version?: unknown }).version;
  if (typeof version !== "number" || !Number.isInteger(version)) return null;
  const parsed = viewOpSchema.safeParse(pending);
  return parsed.success ? { ...(parsed.data as ChartOp), seq: version } : { op: "unsupported", seq: version };
}

type AppState = {
  symbol?: string;
  timeframe?: string;
  range?: { from: string; to: string };
  indicators?: Array<{ name: string; type?: string; pineScriptCodeId?: string }>;
  levels?: Array<{ price: number; label?: string }>;
  zones?: Array<{ low: number; high: number; label?: string }>;
  otherDrawings?: number;
  candlesLoaded?: boolean;
  error?: string;
};

type AppSession = {
  state?: AppState | null;
  version?: number;
  ackedVersion?: number;
  pendingOps?: unknown[];
  truncated?: boolean;
};

const label = (value: string | undefined) => (value ? { label: value.slice(0, 40) } : {});

/** The view's report in the app's words-only state schema. */
export function toAppState(view: ViewState): AppState {
  return {
    symbol: view.symbol,
    timeframe: view.timeframe,
    range: view.range ? { from: view.range.from, to: view.range.to } : undefined,
    indicators: view.indicators?.map((name) => ({ name })),
    levels: view.levels?.map((l) => ({ price: l.price, ...label(l.label) })),
    zones: view.zones?.map((z) => ({ low: z.low, high: z.high, ...label(z.label) })),
    otherDrawings: view.other_drawings,
    candlesLoaded: view.candles_loaded,
    error: view.error,
  };
}

const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** The app's stored state back in the view's terms (for describeView). */
export function fromAppState(state: AppState | null | undefined): ViewState | undefined {
  // No market yet means the view has not reported (the app starts a session with an empty state).
  if (!state || typeof state !== "object" || (!str(state.symbol) && !str(state.timeframe))) return undefined;
  const list = <T>(value: unknown, map: (item: Record<string, unknown>) => T | undefined): T[] | undefined =>
    Array.isArray(value)
      ? value.flatMap((item) => {
          const mapped = item && typeof item === "object" ? map(item as Record<string, unknown>) : undefined;
          return mapped === undefined ? [] : [mapped];
        })
      : undefined;
  const range = state.range && str(state.range.from) && str(state.range.to) ? { from: state.range.from, to: state.range.to } : undefined;
  return {
    symbol: str(state.symbol),
    timeframe: str(state.timeframe),
    range,
    indicators: list(state.indicators, (i) => str(i.name)),
    levels: list(state.levels, (l) => (num(l.price) !== undefined ? { price: l.price as number, label: str(l.label) } : undefined)),
    zones: list(state.zones, (z) =>
      num(z.low) !== undefined && num(z.high) !== undefined ? { low: z.low as number, high: z.high as number, label: str(z.label) } : undefined,
    ),
    other_drawings: num(state.otherDrawings),
    candles_loaded: typeof state.candlesLoaded === "boolean" ? state.candlesLoaded : undefined,
    error: str(state.error),
  };
}

/**
 * The store for an app session. chart_command holds the write key (from the
 * chart_id); the view holds the read key (from the chart_open result's
 * `_meta`, which the model does not see) and passes it on chart_sync.
 */
export function appStore(id: string, keys: { writeKey?: string; readKey?: string }): ChartStore {
  const read = (sessionKey: string, after: number) =>
    appGetChartSession<AppSession>(base(id), { sessionKey, query: { after: String(after) } });

  return {
    backend: "app",

    async push(ops) {
      if (!keys.writeKey) return { gone: true };
      try {
        const queued = await appSendChartSession<{ version?: number }>(`${base(id)}/commands`, {
          sessionKey: keys.writeKey,
          // JSON leaves out the fields a normalized op left undefined; the app refuses unknown ones.
          body: { ops: JSON.parse(JSON.stringify(ops)) as ChartOp[] },
        });
        return typeof queued?.version === "number" ? { version: queued.version } : { refused: "the chart did not confirm the changes" };
      } catch (error) {
        if (isAuthError(error)) throw error;
        if (isStatus(error, 404)) return { gone: true };
        if (isStatus(error, 409) || isStatus(error, 400)) return { refused: (error as Error).message };
        throw error;
      }
    },

    async waitForAck(version, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      let view: ViewState | undefined;
      if (!keys.writeKey) return { applied: false };
      for (;;) {
        try {
          const session = await read(keys.writeKey, version);
          view = fromAppState(session.state) ?? view;
          if ((session.ackedVersion ?? 0) >= version) return { applied: true, view };
        } catch (error) {
          if (isAuthError(error)) throw error;
          if (isStatus(error, 404)) return { applied: false, view };
          // A slow or failed poll: try again until the deadline.
        }
        if (Date.now() + POLL_MS > deadline) return { applied: false, view };
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    },

    async sync(ackedSeq, view) {
      if (!keys.readKey) return null;
      let session: AppSession;
      try {
        session = await read(keys.readKey, ackedSeq);
      } catch (error) {
        if (isAuthError(error)) throw error;
        if (isStatus(error, 404)) return null;
        throw error;
      }
      const statePath = `${base(id)}/state`;
      try {
        await appSendChartSession(statePath, {
          sessionKey: keys.readKey,
          body: view ? { ackedVersion: ackedSeq, state: toAppState(view) } : { ackedVersion: ackedSeq },
        });
      } catch (error) {
        if (isAuthError(error)) throw error;
        if (!view || !isStatus(error, 400)) throw error;
        // The app refused the report's shape: still acknowledge, so chart_command does not wait in vain.
        await appSendChartSession(statePath, { sessionKey: keys.readKey, body: { ackedVersion: ackedSeq } });
      }
      const ops = (session.pendingOps ?? []).map(toViewOp).filter((op): op is SequencedOp => op !== null && op.seq > ackedSeq);
      return { ops };
    },
  };
}

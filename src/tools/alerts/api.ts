/*
  Typed wrappers over the app's alert routes (LuxAlgo Alerts: Price Alerts
  and Custom Alerts, rule types `price` and `agent`). Every route needs a
  signed-in member and acts only on their own alerts; plan limits are the
  app's (403, relayed by the auth wrapper). The routes answer 404 while the
  app's alerts are switched off for the account.

  Shapes mirror the app's wire contracts; the rule itself is the alerts
  engine's rule (a market scope, a condition, a frequency, actions).
*/
import { appGet, appSend } from "../../platform/app-client.js";

export type AlertMarketRef = { source: string; symbol: string; session?: "regular" | "extended" };

export type AlertScope =
  | { kind: "market"; market: AlertMarketRef }
  | { kind: "list"; markets: AlertMarketRef[] }
  | { kind: "watchlist"; watchlistId: string }
  | { kind: "universe"; source: string };

export type AlertFrequency =
  | { kind: "once" }
  | { kind: "once_per_bar"; tf: number }
  | { kind: "once_per_bar_close"; tf: number }
  | { kind: "once_per_minute" }
  | { kind: "every_time"; minIntervalMs: number };

export type AlertRule = {
  id: string;
  type: "price" | "agent";
  name: string;
  scope: AlertScope;
  condition: Record<string, unknown>;
  frequency: AlertFrequency;
  actions: Array<{ destinationId: string; template?: string }>;
  status: AlertStatus;
  createdAt: number;
};

export type AlertStatus = "active" | "paused" | "triggered" | "expired" | "suspended_plan" | "error";
export type AlertLiveState = "arming" | "live" | "unconfirmed" | "unknown" | "error";

export type AlertView = {
  rule: AlertRule;
  statusReason: string | null;
  statusMarket: string | null;
  origin: Record<string, string> | null;
  liveState: AlertLiveState | null;
  armedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AlertUsage = { price: { active: number; limit: number | null }; agent: { active: number; limit: number | null } };

export type AlertEvent = {
  id: string;
  ruleId: string;
  ruleName: string | null;
  market: string;
  eventTime: string;
  barTime: string;
  payload: Record<string, unknown>;
  flags: string[];
  bar: number[] | null;
  deliveries: Array<{ destinationId: string; kind: string | null; status: string; updatedAt: string }>;
};

export type DraftPreview =
  | {
      status: "ok";
      count: number;
      perDay: number;
      days: number;
      noisy: boolean;
      onlyOnce: boolean;
      fromMs: number;
      lastBarTime: number;
      recentFires: Array<{ time: number; price: number | null; message: string }>;
    }
  | { status: "unavailable"; reason: string };

export type DraftAnswer = { rule: Record<string, unknown>; defaultTemplate: string; preview: DraftPreview };

export type AlertDraft = {
  draft: {
    type: "price" | "agent";
    name?: string;
    scope: { kind: "market"; market: AlertMarketRef };
    condition: Record<string, unknown>;
    frequency: AlertFrequency;
    tf?: number;
  };
  script?: { libraryId: string; inputs?: Record<string, string | number | boolean | null> };
  native?: { type: string; inputs?: Record<string, unknown> };
};

const rulePath = (id: string) => `/api/alert-rules/${encodeURIComponent(id)}`;

export const listAlerts = (query: { type?: "price" | "agent"; status?: AlertStatus }) =>
  appGet<{ rules: AlertView[]; usage: AlertUsage }>("/api/alert-rules", { type: query.type, status: query.status });

export const createAlert = async (rule: Record<string, unknown>) =>
  (await appSend<{ rule: AlertView }>("POST", "/api/alert-rules", { body: { rule, status: "active" } })).rule;

export const previewAlert = (draft: AlertDraft) => appSend<DraftAnswer>("POST", "/api/alert-rules/preview", { body: draft });

export const pauseAlert = async (id: string) => (await appSend<{ rule: AlertView }>("POST", `${rulePath(id)}/pause`)).rule;

export const resumeAlert = async (id: string) => (await appSend<{ rule: AlertView }>("POST", `${rulePath(id)}/resume`)).rule;

export const listAlertEvents = (query: { ruleId?: string; cursor?: string; limit?: number }) =>
  appGet<{ events: AlertEvent[]; nextCursor: string | null }>("/api/alert-events", {
    ruleId: query.ruleId,
    cursor: query.cursor,
    limit: query.limit === undefined ? undefined : String(query.limit),
  });

/** The member's in-app channel (their phones and the web), by id and status only; empty when they have none. */
export const inAppDestinations = async () =>
  (await appGet<{ destinations: Array<{ id: string; kind: "inapp"; status: string }> }>("/api/alert-destinations/in-app")).destinations;

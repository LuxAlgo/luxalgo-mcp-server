/*
  Which store a chart lives in, decided once when chart_open runs and carried
  in its chart_id so a stateless server can find it again:

    a.<session id>.<write key>   an app session (./app-session.ts). The model
                                 holds the write key: it changes that one chart
                                 and nothing else, and the server keeps nothing.
    ch_<random>                  an in-memory chart (./store.ts), the fallback.

  The session's read key goes only to the view, in the chart_open result's
  `_meta` (VIEW_META_KEY), never in content or structuredContent, which the
  model sees. The view passes it back on chart_sync and uses it for "Open in
  Vela", which then follows the same chart in a Vela tab.
*/
import { SESSION_ID, SESSION_KEY, appStore, createAppSession } from "./app-session.js";
import { createMemoryChart, memoryStore, type ChartStore } from "./store.js";

/** The chart_open result's `_meta` key for what only the view may know. */
export const VIEW_META_KEY = "luxalgo/chart";

/** What the view gets for an app session: the read key for chart_sync and the follow link for "Open in Vela". */
export type ViewSession = { sync_key: string; follow_url: string };

export type OpenedChart = { chartId: string; backend: ChartStore["backend"]; view?: ViewSession };

const APP_CHART_ID = new RegExp(`^a\\.(${SESSION_ID.source.slice(1, -1)})\\.(${SESSION_KEY.source.slice(1, -1)})$`);

/** A Vela tab that follows the session (the view's "Open in Vela" only; the model gets the plain market link). */
export function followUrl(id: string, readKey: string): string {
  return `https://vela.luxalgo.com/chart?session=${id}.${readKey}`;
}

/** A new chart: an app session when the app offers them, otherwise in memory. */
export async function openChart(): Promise<OpenedChart> {
  const session = await createAppSession();
  if (!session) return { chartId: createMemoryChart(), backend: "memory" };
  return {
    chartId: `a.${session.id}.${session.writeKey}`,
    backend: "app",
    view: { sync_key: session.readKey, follow_url: followUrl(session.id, session.readKey) },
  };
}

/** The store behind a chart_id (plus the view's read key on chart_sync), or null for an unknown id. */
export function storeFor(chartId: string, syncKey?: string): ChartStore | null {
  const app = APP_CHART_ID.exec(chartId);
  if (app) {
    const readKey = syncKey && SESSION_KEY.test(syncKey) ? syncKey : undefined;
    return appStore(app[1], { writeKey: app[2], readKey });
  }
  return memoryStore(chartId);
}

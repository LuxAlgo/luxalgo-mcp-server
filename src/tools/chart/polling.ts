/*
  How often the chart view polls chart_sync. Shared by the view
  (view/chart/main.ts) and the server (./local.ts, ./tools.ts), so the
  server's `next_poll_ms` and its idea of when the view polls next agree with
  what the view does.

  Every poll is a server call (and, for a chart kept in the app's chart
  session, two calls to the app), so the view polls fast only while something
  happens on the chart, slowly when it is idle, and not at all while it is
  hidden or out of view.
*/

/** While something happens: after the chart loads, applies changes, is touched or shown again, or the model is at work on it. */
export const FAST_POLL_MS = 1_000;
/** When the chart is idle. The view adds up to SLOW_POLL_JITTER_MS either way, so idle charts do not poll in step. */
export const SLOW_POLL_MS = 12_000;
export const SLOW_POLL_JITTER_MS = 1_500;
/** How long the view stays fast after each of those events. */
export const FAST_WINDOW_MS = 30_000;
/** After the model's last chart_command on a chart, chart_sync asks its view for fast polls this long. */
export const FAST_AFTER_COMMAND_MS = 30_000;
/** A chart out of view this long stops polling until it is back in view. */
export const OUT_OF_VIEW_STOP_MS = 30_000;

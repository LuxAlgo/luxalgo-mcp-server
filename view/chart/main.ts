/*
  The chart view: one self-contained HTML document (bundled by
  scripts/build-chart-view.mjs) that an MCP Apps host renders in a sandboxed
  iframe for chart_open.

  - Mounts Vela's open-source core (single-chart workspace) with the keyless
    Hyperliquid and Binance providers; candles stream from the exchanges in
    the browser, under the CSP the resource declares.
  - Applies the requested state from the tool input (fast first paint) and the
    tool result (chart_id, normalized state).
  - Polls chart_sync (~1 s, app-only tool) for chart_command ops, applies them,
    acknowledges them, and reports its state in words.
  - Tells the model what is on screen (updateModelContext, words only,
    debounced); a candle click offers "Ask about this" (sendMessage); "Open in
    Vela" (openLink); fullscreen and picture-in-picture (requestDisplayMode);
    follows the host's light/dark theme.

  Never sends bars or exchange prices anywhere: everything that leaves the
  iframe is symbol, timeframe, dates and the names/levels the model itself
  asked for.
*/
import { App, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { VelaWorkspace } from "@luxalgo/vela/workspace";
import { HyperliquidProvider } from "@luxalgo/vela/providers/hyperliquid";
import { BinanceProvider } from "@luxalgo/vela/providers/binance";
import {
  NATIVE_INDICATORS,
  marketWords,
  parseMarket,
  timeframeWords,
  velaChartUrl,
  velaTimeframe,
  type Market,
  type NativeIndicator,
  type RangePreset,
  type Timeframe,
} from "../../src/tools/chart/market.ts";

type Level = { price: number; label?: string };
type Zone = { low: number; high: number; label?: string };
type Op =
  | { op: "set_market"; symbol?: string; timeframe?: Timeframe; seq: number }
  | { op: "add_indicator"; name: NativeIndicator; seq: number }
  | { op: "remove_indicator"; name: NativeIndicator; seq: number }
  | { op: "add_level"; price: number; label?: string; seq: number }
  | { op: "add_zone"; low: number; high: number; label?: string; seq: number }
  | { op: "clear_drawings"; seq: number }
  | { op: "zoom"; range: RangePreset; seq: number };

type ChartArgs = {
  symbol?: string;
  timeframe?: Timeframe;
  indicators?: NativeIndicator[];
  levels?: Level[];
  zones?: Zone[];
  range?: RangePreset | null;
  chart_id?: string;
};

// ---------- diagnostics the spike harness reads (data-* on <body>, console) ----------
const t0 = performance.now();
const body = document.body;
function mark(key: string, value: string | number | boolean) {
  body.dataset[key] = String(value);
}
function log(...args: unknown[]) {
  console.log("[vela-chart]", ...args);
}

function probeWebgl(): string {
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return "unavailable";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return `${canvas.getContext("webgl2") ? "webgl2" : "webgl"}: ${renderer}`;
  } catch (error) {
    return `error: ${String(error)}`;
  }
}
function probeEval(): string {
  try {
    // eslint-disable-next-line no-new-func
    return new Function("return 1")() === 1 ? "allowed" : "unexpected";
  } catch (error) {
    return `blocked: ${(error as Error).name}`;
  }
}
mark("webgl", probeWebgl());
mark("eval", probeEval());
document.addEventListener("securitypolicyviolation", (event) => {
  const entry = `${event.violatedDirective} ${event.blockedURI}`;
  log("CSP violation:", entry);
  mark("cspViolations", `${body.dataset.cspViolations ? body.dataset.cspViolations + " | " : ""}${entry}`);
});
// Count exchange WebSocket opens/errors (the providers' live streams).
const NativeWebSocket = window.WebSocket;
class CountingWebSocket extends NativeWebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    const host = new URL(String(url)).host;
    this.addEventListener("open", () => {
      mark("wsOpen", `${body.dataset.wsOpen ? body.dataset.wsOpen + " " : ""}${host}`);
      log("websocket open", host);
    });
    this.addEventListener("error", () => {
      mark("wsError", `${body.dataset.wsError ? body.dataset.wsError + " " : ""}${host}`);
      log("websocket error", host);
    });
  }
}
window.WebSocket = CountingWebSocket as typeof WebSocket;

// ---------- DOM ----------
const titleEl = document.getElementById("title")!;
const statusEl = document.getElementById("status")!;
const askBtn = document.getElementById("ask") as HTMLButtonElement;
const openBtn = document.getElementById("open") as HTMLButtonElement;
const fullBtn = document.getElementById("fullscreen") as HTMLButtonElement;
const pipBtn = document.getElementById("pip") as HTMLButtonElement;
const chartEl = document.getElementById("chart")!;

function setStatus(text: string) {
  statusEl.textContent = text;
}

// ---------- chart state ----------
let ws: VelaWorkspace | null = null;
let market: Market | null = null;
let timeframe: Timeframe = "4h";
let chartId: string | null = null;
let ackedSeq = 0;
let initialApplied = false;
let candlesLoaded = false;
let displayMode = "inline";
let lastError: string | undefined;
const indicatorHandles = new Map<NativeIndicator, { remove(): void }>();
const levels: Array<Level & { id: string }> = [];
const zones: Array<Zone & { id: string }> = [];
let clickedTime: number | null = null;

const app = new App({ name: "LuxAlgo Vela chart", version: "0.1.0" }, { availableDisplayModes: ["inline", "fullscreen", "pip"] });

function chart() {
  return ws!.chart;
}

function formatDate(ms: number, withTime: boolean): string {
  const d = new Date(ms);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const date = `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (!withTime) return date;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${date} ${hh}:${mm} UTC`;
}
const intraday = () => !["1d", "1w"].includes(timeframe);

function liveDrawingIds(): Set<string> {
  try {
    return new Set(chart().drawings.all().map((d) => d.id));
  } catch {
    return new Set();
  }
}

function viewState() {
  const range = ws ? chart().getVisibleRange() : null;
  const ids = liveDrawingIds();
  // Drop model drawings the user deleted on the chart.
  for (const list of [levels, zones] as Array<Array<{ id: string }>>) {
    for (let i = list.length - 1; i >= 0; i--) if (!ids.has(list[i].id)) list.splice(i, 1);
  }
  const indicators = ws
    ? chart()
        .indicators()
        .map((h) => h.title)
        .filter((t) => t && !/^vol(ume)?$/i.test(t))
    : [];
  return {
    symbol: market?.symbol,
    timeframe,
    range: range ? { from: formatDate(range.from, intraday()), to: formatDate(range.to, intraday()) } : undefined,
    indicators,
    levels: levels.map(({ price, label }) => ({ price, label })),
    zones: zones.map(({ low, high, label }) => ({ low, high, label })),
    other_drawings: Math.max(0, ids.size - levels.length - zones.length),
    theme: document.documentElement.dataset.theme,
    display_mode: displayMode,
    candles_loaded: candlesLoaded,
    ...(lastError ? { error: lastError.slice(0, 200) } : {}),
  };
}

function describe(): string {
  const s = viewState();
  if (!market) return "The chart is loading.";
  let text = `The user is looking at a live Vela chart of ${marketWords(market)}, ${timeframeWords(timeframe)}`;
  if (s.range) text += `, from ${s.range.from} to ${s.range.to}`;
  text += ".";
  text += s.indicators.length ? ` Indicators: ${s.indicators.join(", ")}.` : "";
  if (s.levels.length) text += ` Levels: ${s.levels.map((l) => `${l.label ?? "level"} at ${l.price}`).join(", ")}.`;
  if (s.zones.length) text += ` Zones: ${s.zones.map((z) => `${z.label ?? "zone"} ${z.low} to ${z.high}`).join(", ")}.`;
  if (s.other_drawings) text += ` The user added ${s.other_drawings} drawing(s) of their own.`;
  if (chartId) text += ` chart_id: ${chartId}.`;
  return text;
}

let contextTimer: ReturnType<typeof setTimeout> | undefined;
let lastContext = "";
function scheduleModelContext() {
  clearTimeout(contextTimer);
  contextTimer = setTimeout(async () => {
    const text = describe();
    if (text === lastContext) return;
    lastContext = text;
    try {
      await app.updateModelContext({ content: [{ type: "text", text }] });
      mark("modelContextSent", Number(body.dataset.modelContextSent ?? 0) + 1);
      log("updateModelContext", text);
    } catch (error) {
      log("updateModelContext failed", String(error));
      mark("modelContextError", String(error));
    }
  }, 1200);
}

function refreshHeader() {
  if (!market) return;
  titleEl.textContent = `${marketWords(market)} · ${timeframeWords(timeframe)}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))]);
}

async function waitForCandles(): Promise<void> {
  const start = performance.now();
  while (performance.now() - start < 20_000) {
    if (chart().getVisibleRange()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("no candles after 20 s");
}

function hostTheme(): "light" | "dark" {
  const theme = app.getHostContext()?.theme;
  if (theme === "light" || theme === "dark") return theme;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
  ws?.setTheme(theme);
}

async function mount(args: ChartArgs) {
  const parsed = parseMarket(args.symbol ?? "BTC");
  if ("error" in parsed) {
    lastError = parsed.error;
    setStatus(parsed.error);
    return;
  }
  market = parsed;
  timeframe = args.timeframe ?? "4h";
  refreshHeader();
  const theme = hostTheme();
  document.documentElement.dataset.theme = theme;
  ws = new VelaWorkspace(chartEl, {
    layout: false,
    symbol: market.symbol,
    timeframe: velaTimeframe(timeframe),
    providers: { hyperliquid: () => new HyperliquidProvider(), binance: () => new BinanceProvider() },
    live: true,
    theme,
    persist: false,
    autofocus: false,
  });
  mark("mountedMs", Math.round(performance.now() - t0));
  setStatus("Loading candles");
  try {
    await waitForCandles();
    candlesLoaded = true;
    mark("firstCandlesMs", Math.round(performance.now() - t0));
    setStatus("Live");
  } catch (error) {
    lastError = String(error);
    setStatus("No candles yet: the exchange did not answer");
  }
  try {
    const available = await chart().availableNativeIndicators();
    mark("nativeIndicators", available.map((i: { type: string }) => i.type).join(","));
  } catch {
    /* diagnostics only */
  }
  for (const name of args.indicators ?? []) addIndicator(name);
  for (const level of args.levels ?? []) addLevel(level);
  for (const zone of args.zones ?? []) addZone(zone);
  if (args.range) chart().setVisibleRangePreset(args.range);
  wireChartEvents();
  initialApplied = true;
  scheduleModelContext();
  mark("ready", true);
}

function wireChartEvents() {
  const c = chart();
  const changed = () => scheduleModelContext();
  for (const event of ["market:changed", "indicator:added", "indicator:removed", "drawing:created", "drawing:removed", "viewport:changed"] as const) {
    c.on(event as never, changed as never);
  }
  c.renderer.onClick(({ time }: { time: number | null }) => {
    if (time == null) return;
    clickedTime = time;
    askBtn.hidden = false;
    askBtn.textContent = `Ask about the ${formatDate(time, intraday())} candle`;
  });
}

function addIndicator(name: NativeIndicator) {
  if (indicatorHandles.has(name)) return;
  indicatorHandles.set(name, chart().addNativeIndicator(name));
}

function removeIndicator(name: NativeIndicator) {
  const handle = indicatorHandles.get(name);
  if (handle) {
    handle.remove();
    indicatorHandles.delete(name);
    return;
  }
  // Also remove one the user added from the picker.
  const title = NATIVE_INDICATORS[name].toLowerCase();
  chart()
    .indicators()
    .find((h) => h.nativeType === name || h.title.toLowerCase().startsWith(title))
    ?.remove();
}

function anchorTimes(): { from: number; to: number } {
  const range = chart().getVisibleRange();
  const now = Date.now();
  return range ?? { from: now - 30 * 864e5, to: now };
}

function label(value: string | undefined) {
  return value ? { value, size: "normal" as const, hAlign: "left" as const, vAlign: "top" as const } : undefined;
}

function addLevel(level: Level) {
  const { to } = anchorTimes();
  const drawing = chart().drawings.add("hline", {
    anchors: [{ time: to, price: level.price }],
    text: label(level.label),
    style: { lineColor: "#f5a623", lineWidth: 2 } as never,
  });
  if (drawing) levels.push({ ...level, id: drawing.id });
}

function addZone(zone: Zone) {
  const { from, to } = anchorTimes();
  const drawing = chart().drawings.add("box", {
    anchors: [
      { time: from + (to - from) * 0.25, price: zone.high },
      { time: to, price: zone.low },
    ],
    text: label(zone.label),
  });
  if (drawing) zones.push({ ...zone, id: drawing.id });
}

function clearModelDrawings() {
  const ids = [...levels, ...zones].map((d) => d.id);
  if (ids.length) chart().drawings.removeMany(ids);
  levels.length = 0;
  zones.length = 0;
}

async function applyOp(op: Op) {
  switch (op.op) {
    case "set_market": {
      const next = op.symbol ? parseMarket(op.symbol) : market!;
      if ("error" in next) throw new Error(next.error);
      const symbolChanged = next.symbol !== market?.symbol;
      // Levels and zones belong to the market they were drawn for.
      if (symbolChanged) clearModelDrawings();
      market = next;
      if (op.timeframe) timeframe = op.timeframe;
      refreshHeader();
      candlesLoaded = false;
      await withTimeout(chart().setMarket({ symbol: market.symbol, timeframe: velaTimeframe(timeframe) }), 15_000);
      candlesLoaded = !!chart().getVisibleRange();
      break;
    }
    case "add_indicator":
      addIndicator(op.name);
      break;
    case "remove_indicator":
      removeIndicator(op.name);
      break;
    case "add_level":
      addLevel(op);
      break;
    case "add_zone":
      addZone(op);
      break;
    case "clear_drawings":
      chart().drawings.removeMany(chart().drawings.all().map((d) => d.id));
      levels.length = 0;
      zones.length = 0;
      break;
    case "zoom":
      chart().setVisibleRangePreset(op.range);
      break;
  }
}

// ---------- sync loop ----------
let syncing = false;
async function syncOnce(): Promise<number> {
  if (!chartId || !initialApplied || syncing) return 0;
  syncing = true;
  try {
    const result = await app.callServerTool({
      name: "chart_sync",
      // `context` is harmless when unused and satisfies analytics wrappers that require it.
      arguments: { chart_id: chartId, acked_seq: ackedSeq, state: viewState(), context: "chart view sync" },
    });
    const data = result.structuredContent as { known?: boolean; ops?: Op[] } | undefined;
    const ops = data?.ops ?? [];
    for (const op of ops) {
      if (op.seq <= ackedSeq) continue;
      const started = performance.now();
      try {
        await applyOp(op);
        lastError = undefined;
      } catch (error) {
        lastError = `${op.op} failed: ${(error as Error).message}`;
        log(lastError);
      }
      ackedSeq = op.seq;
      mark("lastOp", `${op.seq}:${op.op}:${Math.round(performance.now() - started)}ms`);
      log("applied op", op.seq, op.op);
    }
    if (ops.length) scheduleModelContext();
    return ops.length;
  } catch (error) {
    log("chart_sync failed", String(error));
    mark("syncError", String(error).slice(0, 200));
    return 0;
  } finally {
    syncing = false;
  }
}

async function syncLoop() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const applied = await syncOnce();
    // Acknowledge right away after applying, so chart_command returns sooner.
    if (applied) {
      await syncOnce();
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// ---------- host wiring ----------
let mountStarted = false;
function start(args: ChartArgs) {
  if (mountStarted) return;
  mountStarted = true;
  mark("toolInputMs", Math.round(performance.now() - t0));
  void mount(args);
}

app.ontoolinput = ({ arguments: args }) => {
  log("tool input", args);
  start((args ?? {}) as ChartArgs);
};

app.ontoolresult = (result) => {
  const data = result.structuredContent as ChartArgs | undefined;
  log("tool result", data?.chart_id);
  if (!data?.chart_id) {
    if (result.isError) setStatus("The chart could not open");
    return;
  }
  chartId = data.chart_id;
  mark("chartId", chartId);
  start(data);
  void syncLoop();
};

app.onhostcontextchanged = (ctx: Partial<McpUiHostContext>) => {
  if (ctx.theme === "light" || ctx.theme === "dark") applyTheme(ctx.theme);
  if (ctx.displayMode) {
    displayMode = ctx.displayMode;
    document.documentElement.dataset.displayMode = displayMode;
  }
  refreshModeButtons();
};

function refreshModeButtons() {
  const available = app.getHostContext()?.availableDisplayModes ?? [];
  fullBtn.textContent = displayMode === "fullscreen" ? "Exit full screen" : "Full screen";
  pipBtn.textContent = displayMode === "pip" ? "Back to chat" : "Picture in picture";
  fullBtn.disabled = !available.includes("fullscreen");
  pipBtn.disabled = !available.includes("pip");
  fullBtn.title = fullBtn.disabled ? "This chat app does not offer full screen" : "";
  pipBtn.title = pipBtn.disabled ? "This chat app does not offer picture in picture" : "";
}

async function requestMode(mode: "inline" | "fullscreen" | "pip") {
  const target = displayMode === mode ? "inline" : mode;
  try {
    const result = await app.requestDisplayMode({ mode: target });
    displayMode = result.mode;
    document.documentElement.dataset.displayMode = displayMode;
    mark("displayModeResult", `${target}->${result.mode}`);
    log("requestDisplayMode", target, "->", result.mode);
  } catch (error) {
    mark("displayModeResult", `${target}->error ${String(error)}`);
  }
  refreshModeButtons();
  scheduleModelContext();
}

fullBtn.addEventListener("click", () => void requestMode("fullscreen"));
pipBtn.addEventListener("click", () => void requestMode("pip"));

openBtn.addEventListener("click", async () => {
  if (!market) return;
  const url = velaChartUrl(market, timeframe);
  try {
    const result = await app.openLink({ url });
    mark("openLink", result.isError ? "refused" : "ok");
  } catch (error) {
    mark("openLink", `error ${String(error)}`);
  }
});

askBtn.addEventListener("click", async () => {
  if (clickedTime == null || !market) return;
  const text = `Tell me about the ${timeframeWords(timeframe).replace(" candles", "")} candle that opened ${formatDate(clickedTime, intraday())} on ${marketWords(market)}.`;
  try {
    const result = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
    mark("sendMessage", result.isError ? "refused" : "ok");
    log("sendMessage", text);
  } catch (error) {
    mark("sendMessage", `error ${String(error)}`);
  }
  askBtn.hidden = true;
});

await app.connect();
mark("connectedMs", Math.round(performance.now() - t0));
const ctx = app.getHostContext();
log("host context", JSON.stringify({ theme: ctx?.theme, displayMode: ctx?.displayMode, availableDisplayModes: ctx?.availableDisplayModes }));
mark("hostModes", (ctx?.availableDisplayModes ?? []).join(","));
displayMode = ctx?.displayMode ?? "inline";
refreshModeButtons();

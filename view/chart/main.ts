/*
  The chart view: one self-contained HTML document (bundled by
  scripts/build-chart-view.mjs) that an MCP Apps host renders in a sandboxed
  iframe for chart_open.

  - Mounts Vela's open-source core (single-chart workspace) with the keyless
    Hyperliquid and Binance providers; candles stream from the exchanges in
    the browser, under the CSP the resource declares.
  - Applies the requested state from the tool input (fast first paint) and the
    tool result (chart_id, normalized state).
  - Polls chart_sync (app-only tool) for chart_command ops, applies them,
    acknowledges them, and reports its state in words: about every second
    while something happens on the chart, every ~12 s when it is idle, not at
    all while it is hidden or out of view (see the sync loop below).
  - Tells the model what is on screen (updateModelContext, debounced); a
    candle click offers "Ask about this" (sendMessage); "Open in Vela"
    (openLink); fullscreen and picture-in-picture (requestDisplayMode);
    follows the host's light/dark theme.
  - On request (chart_command's read op with image: true, handed over by
    chart_sync) adds a size-capped picture of the chart to the model context,
    when the host lists images among the content it takes there.

  Never sends bars anywhere. What leaves the iframe is symbol, timeframe,
  dates and the names/levels the model itself asked for, and, only for a
  market whose numbersAllowed is true (an exchange's public feed, decided in
  src/tools/chart/market.ts), a few numbers read off the chart: the last
  price, the day's change, the visible high and low and each indicator's
  latest value (src/tools/chart/numbers.ts).
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
import {
  FAST_POLL_MS,
  FAST_WINDOW_MS,
  OUT_OF_VIEW_STOP_MS,
  SLOW_POLL_JITTER_MS,
  SLOW_POLL_MS,
} from "../../src/tools/chart/polling.ts";
import {
  describeNumbers,
  indicatorValuesFromReadout,
  priceNumbers,
  type Bar,
  type ChartNumbers,
  type IndicatorValues,
} from "../../src/tools/chart/numbers.ts";

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

// ---------- the candles the chart loads, kept for the allowed numbers ----------
/*
  Vela's chart has no public accessor for its bars, so the providers are
  wrapped: every bar a provider hands the chart (history and the live stream)
  is also kept here, per provider, ticker and timeframe. They never leave the
  iframe; only the scalars priceNumbers() derives from them do, and only for
  a market whose numbersAllowed is true.
*/
const MAX_TAPPED_BARS = 20_000;
const MAX_TAPPED_SERIES = 6;
const tapped = new Map<string, Map<number, Bar>>();

function tapKey(provider: string, ticker: string, tf: string) {
  return `${provider}|${ticker}|${tf}`;
}

function record(key: string, bars: readonly Bar[]) {
  let series = tapped.get(key);
  if (!series) {
    while (tapped.size >= MAX_TAPPED_SERIES) tapped.delete(tapped.keys().next().value as string);
    series = new Map();
    tapped.set(key, series);
  }
  for (const bar of bars) {
    if (bar && Number.isFinite(bar.time)) series.set(bar.time, { time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
  }
  if (series.size > MAX_TAPPED_BARS) {
    const oldest = [...series.keys()].sort((a, b) => a - b).slice(0, series.size - MAX_TAPPED_BARS);
    for (const time of oldest) series.delete(time);
  }
}

type BarSource = {
  getBars(ticker: string, timeframe: string, range: never): Promise<Bar[]>;
  subscribe(ticker: string, timeframe: string, onBar: (bar: Bar) => void): () => void;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tappedProvider<C extends new (...args: any[]) => BarSource>(Base: C, name: string) {
  return class extends Base {
    override async getBars(ticker: string, timeframe: string, range: never) {
      const bars = await super.getBars(ticker, timeframe, range);
      record(tapKey(name, ticker, timeframe), bars);
      return bars;
    }
    override subscribe(ticker: string, timeframe: string, onBar: (bar: Bar) => void) {
      const key = tapKey(name, ticker, timeframe);
      return super.subscribe(ticker, timeframe, (bar) => {
        record(key, [bar]);
        onBar(bar);
      });
    }
  };
}

const TappedHyperliquid = tappedProvider(HyperliquidProvider as unknown as new () => BarSource, "hyperliquid");
const TappedBinance = tappedProvider(BinanceProvider as unknown as new () => BarSource, "binance");

// ---------- DOM ----------
const titleEl = document.getElementById("title")!;
const statusEl = document.getElementById("status")!;
const askBtn = document.getElementById("ask") as HTMLButtonElement;
const openBtn = document.getElementById("open") as HTMLButtonElement;
const fullBtn = document.getElementById("fullscreen") as HTMLButtonElement;
const pipBtn = document.getElementById("pip") as HTMLButtonElement;
const chartEl = document.getElementById("chart")!;
const noteEl = document.getElementById("note")!;

function setStatus(text: string) {
  statusEl.textContent = text;
}

// ---------- chart state ----------
let ws: VelaWorkspace | null = null;
let market: Market | null = null;
let timeframe: Timeframe = "4h";
let chartId: string | null = null;
/** For a chart kept in the app's chart session: the view's own key and the Vela link that follows the chart (chart_open's _meta only). */
let session: { sync_key?: string; follow_url?: string } = {};
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

/** Whether the pointer is over the plot: the data window then reads the hovered bar, not the latest one. */
let hovering = false;
/** Indicator values last read with the pointer off the plot (the latest bar). */
let latestIndicatorValues: IndicatorValues[] = [];

function readIndicatorValues(): IndicatorValues[] {
  if (!ws || hovering) return latestIndicatorValues;
  try {
    const readout = chart().renderer.dataWindowReadout();
    if (readout) latestIndicatorValues = indicatorValuesFromReadout(readout.groups);
  } catch {
    /* a renderer without the readout: no indicator values */
  }
  return latestIndicatorValues;
}

/** The numbers the model may read, for a market that allows them; nothing for any other. */
function chartNumbers(): ChartNumbers {
  if (!ws || !market?.numbersAllowed || !candlesLoaded) return {};
  const series = tapped.get(tapKey(market.venue, market.ticker, velaTimeframe(timeframe)));
  const bars = series ? [...series.values()].sort((a, b) => a.time - b.time) : [];
  const numbers: ChartNumbers = priceNumbers(bars, chart().getVisibleRange(), timeframe);
  const indicatorValues = readIndicatorValues();
  if (indicatorValues.length) numbers.indicator_values = indicatorValues;
  return numbers;
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
    ...chartNumbers(),
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
  const numbers = describeNumbers(s);
  if (numbers) text += ` ${numbers} (Numbers as of ${formatDate(Date.now(), true)}, from the exchange's public feed.)`;
  if (snapshot && snapshot.symbol === market.symbol && snapshot.timeframe === timeframe) {
    text += ` The attached picture shows the chart as the user saw it at ${snapshot.takenAt}.`;
  }
  if (chartId) text += ` chart_id: ${chartId}.`;
  return text;
}

// ---------- a picture of the chart for the model (opt-in, size-capped) ----------
const SNAPSHOT_MAX_WIDTH = 1280;
const SNAPSHOT_MAX_BYTES = 300 * 1024;
/** The last picture sent, kept in later context updates while the chart shows the same market. */
let snapshot: { data: string; mimeType: string; symbol: string; timeframe: Timeframe; takenAt: string } | null = null;

function hostTakesImages(): boolean {
  return !!app.getHostCapabilities()?.updateModelContext?.image;
}

async function sourceCanvas(): Promise<HTMLCanvasElement | null> {
  const fromCell = (ws as unknown as { active?: { screenshotCanvas?: () => HTMLCanvasElement | null } }).active?.screenshotCanvas?.();
  if (fromCell) return fromCell;
  const url = chart().renderer.screenshot();
  if (!url) return null;
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext("2d")!.drawImage(image, 0, 0);
  return canvas;
}

/** The chart as a JPEG at most SNAPSHOT_MAX_WIDTH wide and SNAPSHOT_MAX_BYTES big (base64, without the data: prefix). */
async function captureSnapshot(): Promise<{ data: string; width: number; height: number; bytes: number }> {
  const source = await sourceCanvas();
  if (!source || !source.width || !source.height) throw new Error("this chart cannot export a picture");
  let width = Math.min(SNAPSHOT_MAX_WIDTH, source.width);
  for (let attempt = 0; attempt < 4; attempt++) {
    const height = Math.round((source.height * width) / source.width);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    // JPEG has no transparency: paint the theme's background first.
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor || "#000";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(source, 0, 0, width, height);
    for (const quality of [0.85, 0.7, 0.55]) {
      const data = canvas.toDataURL("image/jpeg", quality).split(",")[1] ?? "";
      const bytes = Math.floor((data.length * 3) / 4);
      if (bytes && bytes <= SNAPSHOT_MAX_BYTES) return { data, width, height, bytes };
    }
    width = Math.round(width * 0.75);
  }
  throw new Error("the picture stayed over the size cap");
}

type SnapshotAnswer =
  | { id: number; outcome: "sent"; width: number; height: number; bytes: number }
  | { id: number; outcome: "unsupported" | "words_only" | "failed"; reason?: string };

/** Answers chart_sync's snapshot request: sends the picture with the words, or says why not. */
async function answerSnapshotRequest(id: number): Promise<SnapshotAnswer> {
  if (!market?.numbersAllowed) return { id, outcome: "words_only" };
  if (!hostTakesImages()) return { id, outcome: "unsupported" };
  try {
    const shot = await captureSnapshot();
    snapshot = { data: shot.data, mimeType: "image/jpeg", symbol: market.symbol, timeframe, takenAt: formatDate(Date.now(), true) };
    await sendModelContext(true);
    mark("snapshotSent", `${shot.width}x${shot.height} ${Math.round(shot.bytes / 1024)} KB`);
    return { id, outcome: "sent", width: shot.width, height: shot.height, bytes: shot.bytes };
  } catch (error) {
    snapshot = null;
    mark("snapshotError", String(error).slice(0, 200));
    return { id, outcome: "failed", reason: String((error as Error).message ?? error).slice(0, 200) };
  }
}

let contextTimer: ReturnType<typeof setTimeout> | undefined;
let lastContext = "";
/** Sends what the chart shows to the model context (each update replaces the last; a kept picture rides along). */
async function sendModelContext(force = false) {
  const text = describe();
  if (text === lastContext && !force) return;
  lastContext = text;
  const keep = snapshot && market && snapshot.symbol === market.symbol && snapshot.timeframe === timeframe ? snapshot : null;
  if (!keep) snapshot = null;
  try {
    await app.updateModelContext({
      content: [{ type: "text", text }, ...(keep ? [{ type: "image" as const, data: keep.data, mimeType: keep.mimeType }] : [])],
    });
    mark("modelContextSent", Number(body.dataset.modelContextSent ?? 0) + 1);
    mark("modelContextText", text);
    log("updateModelContext", text, keep ? "(with picture)" : "");
  } catch (error) {
    log("updateModelContext failed", String(error));
    mark("modelContextError", String(error));
  }
}
function scheduleModelContext() {
  clearTimeout(contextTimer);
  contextTimer = setTimeout(() => void sendModelContext(), 1200);
}
/** Live numbers drift with every tick: refresh the context at most this often when nothing else changed. */
const NUMBERS_REFRESH_MS = 30_000;

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
    providers: {
      hyperliquid: () => new TappedHyperliquid() as unknown as HyperliquidProvider,
      binance: () => new TappedBinance() as unknown as BinanceProvider,
    },
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
  // The range first: levels and zones are placed inside the visible range.
  if (args.range) chart().setVisibleRangePreset(args.range);
  for (const level of args.levels ?? []) addLevel(level);
  for (const zone of args.zones ?? []) addZone(zone);
  wireChartEvents();
  scheduleLevelLabels();
  initialApplied = true;
  // Loaded: the first polls go fast (a chart_command often follows chart_open).
  goFast(true);
  scheduleModelContext();
  if (market.numbersAllowed) setInterval(scheduleModelContext, NUMBERS_REFRESH_MS);
  mark("ready", true);
}

function wireChartEvents() {
  const c = chart();
  const changed = () => scheduleModelContext();
  for (const event of ["market:changed", "indicator:added", "indicator:removed", "drawing:created", "drawing:removed", "viewport:changed"] as const) {
    c.on(event as never, changed as never);
  }
  for (const event of ["market:changed", "viewport:changed"] as const) {
    c.on(event as never, scheduleLevelLabels as never);
  }
  c.renderer.onCrosshairMove(({ time }: { time: number | null }) => {
    hovering = time != null;
  });
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

/** A price for a label: thousands separators, and enough decimals for small coins (80000 -> "80,000"). */
function formatPrice(price: number): string {
  const decimals = price >= 1000 ? 2 : price >= 1 ? 4 : 8;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: decimals, useGrouping: true }).format(price);
}

/** Groups the digits of any number written in a label ("80000" -> "80,000"); leaves years and short numbers alone. */
function groupDigits(text: string): string {
  return text.replace(/\d{5,}(\.\d+)?/g, (n) => formatPrice(Number(n)));
}

/** A level's words on the chart: its label and its price, or just the price. */
function levelText(level: Level): string {
  const price = formatPrice(level.price);
  if (!level.label) return price;
  // A label that is only a number ("3500", "80000.5") reads as a price.
  const bare = level.label.trim().replace(/,/g, "");
  if (/^\d+(\.\d+)?$/.test(bare)) return formatPrice(Number(bare));
  // A label that already carries a number ("80000", "Target 80k") is shown as given, digits grouped.
  return /\d/.test(level.label) ? groupDigits(level.label) : `${level.label} ${price}`;
}

/*
  A horizontal line spans the full width, but Vela draws its label just right
  of the line's anchor, left-aligned, so the anchor's time decides where the
  words sit. Anchored on the newest candle the label runs off the right edge;
  anchored a quarter into the visible range it is fully visible and clear of
  the legend in the top-left corner. LABEL_AT is that spot (share of the
  visible span from its start); the label is moved back there when panning or
  zooming takes it outside [LABEL_MIN_AT, LABEL_MAX_AT].
*/
const LABEL_AT = 0.25;
const LABEL_MIN_AT = 0.05;
const LABEL_MAX_AT = 0.6;

function levelAnchorTime(): number {
  const { from, to } = anchorTimes();
  return from + (to - from) * LABEL_AT;
}

function addLevel(level: Level) {
  const drawing = chart().drawings.add("hline", {
    anchors: [{ time: levelAnchorTime(), price: level.price }],
    text: label(levelText(level)),
    style: { lineColor: "#f5a623", lineWidth: 2 } as never,
  });
  if (drawing) levels.push({ ...level, id: drawing.id });
}

/** Moves the model's level labels back into view after the visible range changed. */
function keepLevelLabelsInView() {
  if (!ws || !levels.length) return;
  const range = chart().getVisibleRange();
  if (!range || range.to <= range.from) return;
  const span = range.to - range.from;
  const time = range.from + span * LABEL_AT;
  const byId = new Map(chart().drawings.all().map((d) => [d.id, d]));
  const patches: Array<{ id: string; patch: { anchors: Array<{ time: number; price: number }> } }> = [];
  for (const level of levels) {
    const anchor = (byId.get(level.id) as { anchors?: Array<{ time: number; price: number }> } | undefined)?.anchors?.[0];
    if (!anchor) continue;
    const at = (anchor.time - range.from) / span;
    if (at >= LABEL_MIN_AT && at <= LABEL_MAX_AT) continue;
    // Keep the price: the user may have dragged the line.
    patches.push({ id: level.id, patch: { anchors: [{ time, price: anchor.price }] } });
  }
  if (patches.length) chart().drawings.updateMany(patches as never);
}

let labelTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleLevelLabels() {
  clearTimeout(labelTimer);
  labelTimer = setTimeout(keepLevelLabelsInView, 250);
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
/*
  Every chart_sync is a server call, so the poll adapts (../../src/tools/chart/polling.ts):
    fast (FAST_POLL_MS) for FAST_WINDOW_MS after the chart loads, after it applied changes or answered a
      snapshot request, after the user touched the chart or moved focus away from it, after it came back
      into view, and whenever chart_sync's next_poll_ms asks for it (the model used chart_command lately);
    slow (SLOW_POLL_MS, with jitter) otherwise;
    stopped while the document is hidden or the chart has been out of view for OUT_OF_VIEW_STOP_MS. Its
      last poll says so (paused) and the first one when it is shown again goes at once.
  Each poll announces the delay it plans (next_poll_ms), so chart_command knows whether to wait for the
  next one or to answer at once that its changes are queued.
*/
let syncing = false;
/** The answer to the last snapshot request, sent with the next chart_sync. */
let snapshotAnswer: SnapshotAnswer | null = null;
let answeredSnapshotId = 0;
let syncCalls = 0;
type SyncOutcome = { handled: number; nextPollMs?: number };
/** One poll. `plannedMs`: the delay announced for the next one; null: this is the last poll before stopping. */
async function syncOnce(plannedMs: number | null): Promise<SyncOutcome> {
  if (!chartId || !initialApplied || syncing) return { handled: 0 };
  syncing = true;
  try {
    mark("syncCalls", ++syncCalls);
    const result = await app.callServerTool({
      name: "chart_sync",
      // `context` is harmless when unused and satisfies analytics wrappers that require it.
      arguments: {
        chart_id: chartId,
        ...(session.sync_key ? { sync_key: session.sync_key } : {}),
        acked_seq: ackedSeq,
        state: viewState(),
        ...(plannedMs === null ? { paused: true } : { next_poll_ms: plannedMs }),
        ...(snapshotAnswer ? { snapshot_answer: snapshotAnswer } : {}),
        context: "chart view sync",
      },
    });
    snapshotAnswer = null;
    const data = result.structuredContent as { known?: boolean; ops?: Op[]; snapshot?: number; next_poll_ms?: number } | undefined;
    const nextPollMs = typeof data?.next_poll_ms === "number" && data.next_poll_ms >= 0 ? data.next_poll_ms : undefined;
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
    // A snapshot is taken after the ops, so it shows the chart they produced.
    if (typeof data?.snapshot === "number" && data.snapshot > answeredSnapshotId) {
      answeredSnapshotId = data.snapshot;
      snapshotAnswer = await answerSnapshotRequest(data.snapshot);
      return { handled: ops.length + 1, nextPollMs };
    }
    return { handled: ops.length, nextPollMs };
  } catch (error) {
    log("chart_sync failed", String(error));
    mark("syncError", String(error).slice(0, 200));
    return { handled: 0 };
  } finally {
    syncing = false;
  }
}

let fastUntil = 0;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let pollDueAt = Infinity;
let ticking = false;
/** True once the last poll before stopping went out; the next poll goes when the chart is shown again. */
let stopped = false;
let pageHidden = document.visibilityState === "hidden";
let outOfViewSince: number | null = null;

function onScreen(): boolean {
  return !pageHidden && !(outOfViewSince !== null && performance.now() - outOfViewSince >= OUT_OF_VIEW_STOP_MS);
}

function plannedDelay(): number {
  if (performance.now() < fastUntil) return FAST_POLL_MS;
  return SLOW_POLL_MS - SLOW_POLL_JITTER_MS + Math.round(Math.random() * 2 * SLOW_POLL_JITTER_MS);
}

function schedulePoll(delayMs: number) {
  clearTimeout(pollTimer);
  pollDueAt = performance.now() + delayMs;
  pollTimer = setTimeout(() => void pollTick(), delayMs);
}

/** Something happened on the chart: poll fast for a while, the next poll within FAST_POLL_MS (or at once). */
function goFast(immediately = false) {
  fastUntil = performance.now() + FAST_WINDOW_MS;
  // While a poll runs, it schedules the next one itself; a stopped chart restarts only when it is shown again.
  if (!chartId || ticking || (stopped && !onScreen())) return;
  const delay = immediately ? 0 : FAST_POLL_MS;
  if (pollDueAt - performance.now() > delay) schedulePoll(delay);
}

async function pollTick() {
  pollTimer = undefined;
  pollDueAt = Infinity;
  if (!chartId || ticking) return;
  ticking = true;
  let next: number | null = null;
  try {
    if (!onScreen()) {
      if (!stopped) {
        stopped = true;
        // The last poll says the chart stops; changes it hands over are applied and acknowledged before stopping.
        for (let i = 0; i < 3 && (await syncOnce(null)).handled > 0; i++);
        mark("polling", "stopped");
      }
    } else {
      stopped = false;
      const planned = plannedDelay();
      const { handled, nextPollMs } = await syncOnce(planned);
      if (handled > 0) {
        // Acknowledge right away, so chart_command returns sooner.
        fastUntil = performance.now() + FAST_WINDOW_MS;
        next = 0;
      } else {
        next = Math.min(planned, nextPollMs ?? planned);
      }
    }
  } finally {
    ticking = false;
  }
  // Shown again, or touched, while that poll was out; or hidden: the last poll goes now.
  if (next === null && onScreen()) next = 0;
  if (next !== null && !onScreen() && !stopped) next = 0;
  if (next !== null && performance.now() < fastUntil) next = Math.min(next, FAST_POLL_MS);
  if (next !== null) {
    mark("polling", next <= FAST_POLL_MS ? "fast" : "slow");
    schedulePoll(next);
  }
}

/** The chart is on screen again: poll at once, then fast. */
function resumePolling() {
  if (!onScreen()) return;
  if (stopped) {
    fastUntil = performance.now() + FAST_WINDOW_MS;
    if (!ticking) schedulePoll(0);
  } else {
    goFast();
  }
}

function startPolling() {
  fastUntil = performance.now() + FAST_WINDOW_MS;
  schedulePoll(0);
}

document.addEventListener("visibilitychange", () => {
  pageHidden = document.visibilityState === "hidden";
  mark("pageHidden", pageHidden);
  if (!chartId) return;
  if (pageHidden) {
    // The last poll goes now, so chart_command knows the chart stopped.
    if (!ticking && !stopped) schedulePoll(0);
  } else {
    resumePolling();
  }
});

if (typeof IntersectionObserver === "function") {
  new IntersectionObserver((entries) => {
    const visible = entries[entries.length - 1]?.isIntersecting ?? true;
    mark("inView", visible);
    if (visible) {
      outOfViewSince = null;
      if (chartId) resumePolling();
    } else if (outOfViewSince === null) {
      outOfViewSince = performance.now();
    }
  }).observe(chartEl);
}

// A hand on the chart, or focus leaving it for the chat (a message about it is likely next).
for (const event of ["pointerdown", "wheel", "keydown", "pointerleave"] as const) {
  chartEl.addEventListener(event, () => goFast(), { passive: true });
}
let lastMoveAt = 0;
chartEl.addEventListener(
  "pointermove",
  () => {
    const now = performance.now();
    if (now - lastMoveAt < 1_000) return;
    lastMoveAt = now;
    goFast();
  },
  { passive: true },
);
window.addEventListener("blur", () => goFast());

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
  const meta = (result._meta as Record<string, unknown> | undefined)?.["luxalgo/chart"] as typeof session | undefined;
  if (meta && typeof meta === "object") session = meta;
  mark("chartId", chartId);
  start(data);
  startPolling();
};

app.onhostcontextchanged = (ctx: Partial<McpUiHostContext>) => {
  if (ctx.theme === "light" || ctx.theme === "dark") applyTheme(ctx.theme);
  if (ctx.displayMode) {
    displayMode = ctx.displayMode;
    document.documentElement.dataset.displayMode = displayMode;
  }
  refreshModeButtons();
};

type DisplayMode = "inline" | "fullscreen" | "pip";

/** ChatGPT's compatibility bridge (it implements MCP Apps; window.openai is an alias). */
type OpenAiBridge = { requestDisplayMode?: (args: { mode: DisplayMode }) => Promise<{ mode?: string } | undefined | void> };
function openAiBridge(): OpenAiBridge | undefined {
  return (window as unknown as { openai?: OpenAiBridge }).openai;
}

/**
 * Whether to offer a mode. A host that reports no modes (or an empty list) is
 * asked anyway: ChatGPT web, for one, offers picture in picture without
 * listing it. Only a host that lists its modes and leaves this one out, with
 * no other way to ask, gets a disabled button.
 */
function modeOffered(mode: DisplayMode): boolean {
  const listed = app.getHostContext()?.availableDisplayModes;
  if (!listed || listed.length === 0) return true;
  if (listed.includes(mode)) return true;
  return typeof openAiBridge()?.requestDisplayMode === "function";
}

function refreshModeButtons() {
  fullBtn.textContent = displayMode === "fullscreen" ? "Exit full screen" : "Full screen";
  pipBtn.textContent = displayMode === "pip" ? "Back to chat" : "Picture in picture";
  // Leaving a mode is always allowed.
  fullBtn.disabled = displayMode !== "fullscreen" && !modeOffered("fullscreen");
  pipBtn.disabled = displayMode !== "pip" && !modeOffered("pip");
  fullBtn.title = fullBtn.disabled ? "This chat app does not offer full screen" : "";
  pipBtn.title = pipBtn.disabled ? "This chat app does not offer picture in picture" : "";
}

let noteTimer: ReturnType<typeof setTimeout> | undefined;
function showNote(text: string, detail?: string) {
  clearTimeout(noteTimer);
  noteEl.textContent = text;
  if (detail) {
    const small = document.createElement("small");
    small.textContent = detail;
    noteEl.append(small);
  }
  noteEl.hidden = false;
  noteTimer = setTimeout(() => {
    noteEl.hidden = true;
  }, detail ? 9000 : 5000);
}

function setDisplayMode(mode: string) {
  displayMode = mode;
  document.documentElement.dataset.displayMode = displayMode;
}

const MODE_WORDS: Record<DisplayMode, string> = { inline: "in the chat", fullscreen: "full screen", pip: "picture in picture" };

async function requestMode(mode: DisplayMode) {
  const target: DisplayMode = displayMode === mode ? "inline" : mode;
  let granted: string | undefined;
  try {
    const result = await withTimeout(app.requestDisplayMode({ mode: target }), 4000);
    granted = result?.mode;
    mark("displayModeResult", `${target}->${granted ?? "no answer"}`);
  } catch (error) {
    mark("displayModeResult", `${target}->error ${String(error).slice(0, 120)}`);
  }
  // Not granted as asked: try ChatGPT's own bridge, when the page has one.
  const bridge = openAiBridge();
  if (granted !== target && typeof bridge?.requestDisplayMode === "function") {
    try {
      const result = await withTimeout(Promise.resolve(bridge.requestDisplayMode({ mode: target })), 4000);
      // The bridge may answer without a mode; the host context then reports the change.
      granted = (result && typeof result === "object" && typeof result.mode === "string" ? result.mode : undefined) ?? target;
      mark("displayModeFallback", `${target}->${granted}`);
    } catch (error) {
      mark("displayModeFallback", `${target}->error ${String(error).slice(0, 120)}`);
    }
  }
  log("requestDisplayMode", target, "->", granted ?? "refused");
  if (granted === "inline" || granted === "fullscreen" || granted === "pip") setDisplayMode(granted);
  if (granted !== target) {
    if (target === "inline") showNote("The chat app kept this view.");
    else if (granted && granted !== "inline") showNote(`The chat app showed the chart ${MODE_WORDS[granted as DisplayMode] ?? granted} instead.`);
    else {
      // What the host actually answered, so a refusal can be diagnosed from a screenshot.
      const offered = app.getHostContext()?.availableDisplayModes;
      showNote(
        `This chat app did not open ${MODE_WORDS[target]}. The chart stays here.`,
        `Host modes: ${offered?.length ? offered.join(", ") : "not reported"} · answer: ${granted ?? "none"} · ChatGPT bridge: ${bridge ? "yes" : "no"}`,
      );
    }
  }
  refreshModeButtons();
  scheduleModelContext();
}

fullBtn.addEventListener("click", () => void requestMode("fullscreen"));
pipBtn.addEventListener("click", () => void requestMode("pip"));

openBtn.addEventListener("click", async () => {
  if (!market) return;
  // An app session opens a Vela tab that follows this same chart.
  const url = session.follow_url ?? velaChartUrl(market, timeframe);
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

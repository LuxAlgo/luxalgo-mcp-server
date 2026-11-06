/*
  Live Vela charts (opt-in: LUXALGO_CHART_TOOLS=on or a Vercel preview).

  1. The chart-session helpers in platform/app-client.ts, in process with a
     stubbed fetch: they refuse every route but the app's chart-session ones,
     and forward the caller's sign-in only when a session is created. And the
     one place that decides whether the model may read numbers off a chart:
     only providers whose candles come from an exchange's public feed.
  2. The server under test, when it lists the chart tools: chart_open,
     chart_command and the view's chart_sync work end to end. While the app
     does not offer chart sessions (it answers 404) this is the in-memory
     fallback.
  3. The app-session backend against a stand-in for the app's chart-session
     routes (a local server speaking the app's contract), on a node-http entry
     this suite starts itself: the model gets the write key only, the view the
     read key only (in `_meta`), and creating falls back to memory when the
     app answers 404 or cannot be reached.
*/
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const CHART_TOOLS = ["chart_open", "chart_command", "chart_sync"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run({ client, check }) {
  await helperChecks(check);
  await numbersPolicyChecks(check);

  const { tools } = await client.listTools();
  if (!tools.some((t) => t.name === "chart_open")) {
    console.log("(chart tools are off on the server under test; set LUXALGO_CHART_TOOLS=on to run them end to end)");
  } else {
    await endToEnd(client, check, "on the server under test");
  }

  await appBackendChecks(check);
}

// ── 1. the narrow helpers ─────────────────────────────────────────────────

async function helperChecks(check) {
  const { appSendChartSession, appGetChartSession } = await import("../../dist/platform/app-client.js");
  const { runWithAccess } = await import("../../dist/auth/access-context.js");
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), method: init.method, headers: { ...init.headers }, redirect: init.redirect });
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const refuses = async (fn) => {
      const before = seen.length;
      try {
        await fn();
        return false;
      } catch {
        return seen.length === before;
      }
    };
    const key = { sessionKey: "k".repeat(24) };
    const otherRoutes = [
      "/api/journal/notes",
      "/api/account/me",
      "/api/chart-sessions/",
      "/api/chart-sessions/abc/other",
      "/api/chart-sessions/abc/commands/extra",
      "/api/chart-sessions/../account/me",
      "/api/chart-sessions/abc%2F..",
      "/api/chart-sessions?x=1",
      "//elsewhere.example/api/chart-sessions",
      "https://elsewhere.example/api/chart-sessions",
    ];
    const refusedAll = [];
    for (const path of otherRoutes) {
      refusedAll.push((await refuses(() => appSendChartSession(path, key))) && (await refuses(() => appGetChartSession(path, key))));
    }
    check(
      "the chart-session helper refuses every route but the app's chart-session ones, before any request goes out",
      refusedAll.every(Boolean),
      otherRoutes.filter((_, i) => !refusedAll[i]).join(", ") || `${otherRoutes.length} routes refused`,
    );
    check(
      "the chart-session helper takes only the method each route expects, and a key on every call but the create",
      (await refuses(() => appGetChartSession("/api/chart-sessions", {}))) &&
        (await refuses(() => appGetChartSession("/api/chart-sessions/abc/commands", key))) &&
        (await refuses(() => appSendChartSession("/api/chart-sessions/abc", key))) &&
        (await refuses(() => appSendChartSession("/api/chart-sessions/abc/commands", {}))) &&
        (await refuses(() => appGetChartSession("/api/chart-sessions/abc", {}))),
    );

    seen.length = 0;
    await runWithAccess({ token: "signed-in-token" }, async () => {
      await appSendChartSession("/api/chart-sessions");
      await appSendChartSession("/api/chart-sessions/abc/commands", { ...key, body: { ops: [] } });
      await appSendChartSession("/api/chart-sessions/abc/state", { ...key, body: { ackedVersion: 0 } });
      await appGetChartSession("/api/chart-sessions/abc", { ...key, query: { after: "0" } });
    });
    await appSendChartSession("/api/chart-sessions");
    const [create, commands, state, read, anonymousCreate] = seen;
    check(
      "a signed-in caller's token goes with creating a chart session and with no other chart-session call",
      create?.headers.authorization === "Bearer signed-in-token" &&
        [commands, state, read].every((call) => call && !("authorization" in call.headers)),
      seen.map((call) => `${call.method} ${new URL(call.url).pathname}: ${"authorization" in call.headers ? "token" : "no token"}`).join("; "),
    );
    check(
      "an anonymous caller can create a chart session (no token, no sign-in asked)",
      anonymousCreate && !("authorization" in anonymousCreate.headers),
    );
    check(
      "every chart-session call after the create carries its key in x-chart-session-key, and none follows a redirect",
      [commands, state, read].every((call) => call.headers["x-chart-session-key"] === key.sessionKey) &&
        !("x-chart-session-key" in create.headers) &&
        seen.every((call) => call.redirect === "error"),
    );
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function numbersPolicyChecks(check) {
  const { numbersAllowedFor, parseMarket } = await import("../../dist/tools/chart/market.js");
  const exchangeFed = ["hyperliquid", "binance"];
  const others = ["polygon", "databento", "cme", "nasdaq", "nyse", "alpaca", "tradestation", "coinbase", "vendor", "", "BINANCE", "constructor", "__proto__", "toString"];
  check(
    "the model may read numbers off a chart only when its candles come from an exchange's public feed (Hyperliquid, Binance)",
    exchangeFed.every((p) => numbersAllowedFor(p) === true) && parseMarket("BTC").numbersAllowed === true && parseMarket("binance:ETHUSDT").numbersAllowed === true,
  );
  check(
    "any other provider (a data vendor, futures, stocks, or one the chart does not know) stays words only",
    others.every((p) => numbersAllowedFor(p) === false),
    others.filter((p) => numbersAllowedFor(p) !== false).join(", ") || `${others.length} providers words only`,
  );
}

// ── 2. end to end through MCP ─────────────────────────────────────────────

/**
 * Plays the chart view: polls chart_sync, "applies" ops, reports its state with
 * the numbers it would read off an exchange-fed chart, answers snapshot requests
 * the way a host that takes no images makes it.
 */
function startView(client, chartId, syncKey, { symbol = "hyperliquid:BTC" } = {}) {
  let acked = 0;
  let stopped = false;
  let snapshotAnswer;
  const state = {
    symbol,
    timeframe: "4h",
    indicators: [],
    levels: [],
    zones: [],
    candles_loaded: true,
    theme: "dark",
    display_mode: "inline",
    last_price: 2231.4,
    change_pct: -0.4,
    visible_high: 2310,
    visible_low: 2180.5,
    indicator_values: [],
  };
  const loop = (async () => {
    while (!stopped) {
      const result = await client.callTool({
        name: "chart_sync",
        arguments: {
          chart_id: chartId,
          ...(syncKey ? { sync_key: syncKey } : {}),
          acked_seq: acked,
          state,
          ...(snapshotAnswer ? { snapshot_answer: snapshotAnswer } : {}),
        },
      });
      snapshotAnswer = undefined;
      const ops = result.structuredContent?.ops ?? [];
      for (const op of ops) {
        if (op.op === "set_market") Object.assign(state, op.symbol ? { symbol: op.symbol } : {}, op.timeframe ? { timeframe: op.timeframe } : {});
        if (op.op === "add_indicator") {
          state.indicators.push(op.name === "rsi" ? "RSI" : op.name);
          if (op.name === "rsi") state.indicator_values.push({ name: "Relative Strength Index", values: { RSI: 38.2 } });
        }
        if (op.op === "add_level") state.levels.push({ price: op.price, label: op.label });
        acked = Math.max(acked, op.seq);
      }
      const snapshot = result.structuredContent?.snapshot;
      if (typeof snapshot === "number") snapshotAnswer = { id: snapshot, outcome: "unsupported" };
      if (!ops.length && !snapshotAnswer) await sleep(150);
    }
  })();
  return async () => {
    stopped = true;
    await loop;
  };
}

const textOf = (result) => result.content?.map((c) => c.text ?? "").join(" ") ?? "";

async function endToEnd(client, check, where) {
  const opened = await client.callTool({ name: "chart_open", arguments: { symbol: "BTC", timeframe: "4h" } });
  const chartId = opened.structuredContent?.chart_id;
  const syncKey = opened._meta?.["luxalgo/chart"]?.sync_key;
  check(
    `${where}, chart_open opens a chart and returns its chart_id`,
    !opened.isError && typeof chartId === "string",
    `${chartId?.startsWith("a.") ? "app session" : "in memory"}`,
  );
  if (!chartId) return;

  const stopView = startView(client, chartId, syncKey);
  const commanded = await client.callTool({
    name: "chart_command",
    arguments: { chart_id: chartId, ops: [{ op: "set_market", symbol: "ETH" }, { op: "add_indicator", name: "rsi" }, { op: "add_level", price: 4000, label: "Test level" }] },
  });
  const read = await client.callTool({ name: "chart_command", arguments: { chart_id: chartId, ops: [{ op: "read" }] } });
  const pictured = await client.callTool({ name: "chart_command", arguments: { chart_id: chartId, ops: [{ op: "read", image: true }] } });
  await stopView();
  const text = textOf(commanded);
  check(
    `${where}, chart_command changes the open chart and answers with what it now shows, in words`,
    !commanded.isError && commanded.structuredContent?.applied === true && /ETH on Hyperliquid/.test(text) && /RSI/.test(text) && /Test level at 4000/.test(text),
    text.slice(0, 160),
  );
  check(
    `${where}, on a crypto chart chart_command's reply carries the last price, the day's change and the latest RSI`,
    /Last 2,231\.4 \(-0\.4% today\)/.test(text) &&
      /Visible range: high 2,310, low 2,180\.5/.test(text) &&
      /RSI 38\.2/.test(text) &&
      commanded.structuredContent?.view?.last_price === 2231.4 &&
      commanded.structuredContent?.view?.indicator_values?.[0]?.values?.RSI === 38.2,
    text.slice(-160),
  );
  // Data rule: model-visible results carry a few scalars at most, never bars.
  const visible = JSON.stringify([opened.content, opened.structuredContent, commanded.content, commanded.structuredContent]);
  check(
    `${where}, no model-visible chart result carries candles or bars, and chart_open carries no prices`,
    !/"(open|high|low|close|volume|bars|candles|ohlc)"\s*:/i.test(visible) && /carries no prices/.test(textOf(opened)),
  );

  check(
    `${where}, chart_command's read op changes nothing and returns what the chart shows with its numbers`,
    !read.isError && /^The chart shows ETH on Hyperliquid/.test(textOf(read)) && /Last 2,231\.4/.test(textOf(read)) && /RSI 38\.2/.test(textOf(read)) && read.structuredContent?.seq === undefined,
    textOf(read).slice(0, 160),
  );
  check(
    `${where}, asking for a picture where the chat app takes no images says so and still answers in words`,
    !pictured.isError && pictured.structuredContent?.snapshot === "unsupported" && /does not take pictures/.test(textOf(pictured)) && /Last 2,231\.4/.test(textOf(pictured)),
    textOf(pictured).slice(-160),
  );

  // A market from any other source is described in words only, even when a view reports numbers for it.
  const vendor = await client.callTool({ name: "chart_open", arguments: { symbol: "SOL" } });
  const vendorId = vendor.structuredContent?.chart_id;
  const stopVendor = startView(client, vendorId, vendor._meta?.["luxalgo/chart"]?.sync_key, { symbol: "databento:ES.c.0" });
  await sleep(400);
  const vendorRead = await client.callTool({ name: "chart_command", arguments: { chart_id: vendorId, ops: [{ op: "read", image: true }] } });
  await stopVendor();
  check(
    `${where}, a chart whose candles do not come from an exchange's public feed is read in words only, with no numbers and no picture`,
    !vendorRead.isError &&
      !/Last |RSI|Visible range/.test(textOf(vendorRead)) &&
      vendorRead.structuredContent?.view?.last_price === undefined &&
      vendorRead.structuredContent?.snapshot === "words_only",
    textOf(vendorRead).slice(0, 200),
  );

  const unknown = await client.callTool({ name: "chart_command", arguments: { chart_id: "ch_doesnotexist", ops: [{ op: "clear_drawings" }] } });
  check(`${where}, chart_command on an unknown chart says so`, unknown.isError === true && /No open chart/.test(textOf(unknown)));
}

// ── 3. the app-session backend against the app's contract ─────────────────

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const OP_FIELDS = {
  set_market: ["symbol", "timeframe"],
  add_indicator: ["name", "pineScriptCodeId"],
  remove_indicator: ["name", "pineScriptCodeId"],
  add_level: ["price", "label"],
  add_zone: ["low", "high", "label"],
  clear_drawings: [],
  zoom: ["range", "from", "to"],
  save_layout: ["name"],
  load_layout: ["name"],
};
const STATE_FIELDS = ["symbol", "timeframe", "range", "indicators", "levels", "zones", "otherDrawings", "candlesLoaded", "error"];

/** A stand-in for the app's chart-session routes: strict like the app, every refusal a 404. */
function startFakeApp(port) {
  const sessions = new Map();
  const log = [];
  let enabled = true;
  let counter = 0;
  const server = createHttpServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const key = req.headers["x-chart-session-key"];
    log.push({ method: req.method, path: url.pathname, key, authorization: req.headers.authorization });
    const send = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status < 300 ? { data } : { errors: [{ message: data }] }));
    };
    if (!enabled) return send(404, "Not found");
    const match = url.pathname.match(/^\/api\/chart-sessions(?:\/([A-Za-z0-9_-]+)(?:\/(commands|state))?)?$/);
    if (!match) return send(404, "Not found");
    const [, id, sub] = match;
    if (!id && req.method === "POST") {
      counter++;
      const session = { id: `sess${counter}`, writeKey: `w${counter}`.padEnd(24, "x"), readKey: `r${counter}`.padEnd(24, "y"), version: 0, ackedVersion: 0, ops: [], state: null };
      sessions.set(session.id, session);
      return send(201, { id: session.id, writeKey: session.writeKey, readKey: session.readKey });
    }
    const session = sessions.get(id);
    if (!session) return send(404, "Not found");
    const json = body ? JSON.parse(body) : {};
    if (sub === "commands" && req.method === "POST") {
      if (key !== session.writeKey) return send(404, "Not found");
      const ops = json.ops;
      const strict = Array.isArray(ops) && ops.length >= 1 && ops.length <= 20 && ops.every((op) => OP_FIELDS[op.op] && Object.keys(op).every((k) => k === "op" || OP_FIELDS[op.op].includes(k)));
      if (!strict) return send(400, "Invalid ops");
      for (const op of ops) session.ops.push({ ...op, version: ++session.version });
      return send(200, { version: session.version });
    }
    if (sub === "state" && req.method === "POST") {
      if (key !== session.readKey) return send(404, "Not found");
      if (json.state && Object.keys(json.state).some((k) => !STATE_FIELDS.includes(k))) return send(400, "Invalid state");
      session.ackedVersion = Math.max(session.ackedVersion, json.ackedVersion ?? 0);
      if (json.state) session.state = json.state;
      return send(200, { ackedVersion: session.ackedVersion });
    }
    if (!sub && req.method === "GET") {
      if (key !== session.readKey && key !== session.writeKey) return send(404, "Not found");
      const after = Number(url.searchParams.get("after") ?? 0);
      return send(200, {
        state: session.state ?? {},
        version: session.version,
        ackedVersion: session.ackedVersion,
        pendingOps: session.ops.filter((op) => op.version > after),
        truncated: false,
        updatedAt: new Date().toISOString(),
      });
    }
    return send(404, "Not found");
  });
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () =>
      resolve({ log, sessions, setEnabled: (on) => (enabled = on), close: () => new Promise((done) => (server.close(() => done()), server.closeAllConnections())) }),
    ),
  );
}

async function startEntry(appOrigin) {
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/entries/node-http.js"], {
    env: { ...process.env, PORT: String(port), MCP_RESOURCE: `http://localhost:${port}/mcp`, LUXALGO_APP_ORIGIN: appOrigin, LUXALGO_CHART_TOOLS: "on" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("node-http entry did not start within 15 s")), 15_000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`node-http entry exited early (${code})`));
    });
  });
  return { url: `http://localhost:${port}/mcp`, stop: () => child.kill() };
}

async function appBackendChecks(check) {
  const appPort = await freePort();
  const app = await startFakeApp(appPort);
  const entry = await startEntry(`http://127.0.0.1:${appPort}`);
  const mcp = new Client({ name: "smoke-chart", version: "0.0.0" });
  try {
    await mcp.connect(new StreamableHTTPClientTransport(new URL(entry.url)));

    const opened = await mcp.callTool({ name: "chart_open", arguments: { symbol: "BTC", timeframe: "1h" } });
    const session = app.sessions.get("sess1");
    const chartId = opened.structuredContent?.chart_id;
    const view = opened._meta?.["luxalgo/chart"];
    check(
      "with chart sessions on in the app, chart_open keeps the chart there and gives the model its write key only",
      session && chartId === `a.${session.id}.${session.writeKey}`,
      chartId,
    );
    const modelVisible = JSON.stringify([opened.content, opened.structuredContent]);
    check(
      "the read key reaches the view only (chart_open's _meta), never the model, and the model's Vela link stays the plain market link",
      session &&
        view?.sync_key === session.readKey &&
        view?.follow_url === `https://vela.luxalgo.com/chart?session=${session.id}.${session.readKey}` &&
        !modelVisible.includes(session.readKey) &&
        opened.structuredContent?.chart_url === "https://vela.luxalgo.com/chart?symbol=hyperliquid%3ABTC&tf=1h",
    );
    check(
      "an anonymous chart_open creates the app session without a token",
      app.log.filter((call) => call.method === "POST" && call.path === "/api/chart-sessions").every((call) => !call.authorization),
    );

    await endToEnd(mcp, check, "on an app session");
    const s2 = app.sessions.get("sess2");
    const later = app.log.filter((call) => s2 && call.path.startsWith(`/api/chart-sessions/${s2.id}`));
    check(
      "chart_command writes with the write key and the view reads and reports with the read key, with no token on any of them",
      s2 &&
        later.length > 0 &&
        app.log.filter((call) => call.path !== "/api/chart-sessions").every((call) => !call.authorization) &&
        later.filter((call) => call.path.endsWith("/commands")).every((call) => call.key === s2.writeKey) &&
        later.filter((call) => call.path.endsWith("/state")).every((call) => call.key === s2.readKey) &&
        later.some((call) => call.method === "GET" && call.key === s2.readKey),
      `${later.length} calls`,
    );
    check(
      "the view's report reaches the app in its words-only state schema (no theme, display mode or numbers)",
      s2?.state && Object.keys(s2.state).every((k) => STATE_FIELDS.includes(k)) && s2.state.symbol === "hyperliquid:ETH",
      JSON.stringify(s2?.state ?? {}).slice(0, 160),
    );

    const noKey = await mcp.callTool({ name: "chart_sync", arguments: { chart_id: chartId, acked_seq: 0 } });
    check("chart_sync without the view's key learns nothing about an app session", noKey.structuredContent?.known === false);

    const queued = await mcp.callTool({ name: "chart_command", arguments: { chart_id: chartId, ops: [{ op: "zoom", range: "1M" }] } });
    check(
      "with no chart on screen, chart_command answers that the change is queued",
      !queued.isError && queued.structuredContent?.applied === false && /Queued 1 change/.test(textOf(queued)) && !/shows \./.test(textOf(queued)),
      textOf(queued).slice(0, 120),
    );
    const queuedReported = s2 && (await mcp.callTool({ name: "chart_command", arguments: { chart_id: `a.${s2.id}.${s2.writeKey}`, ops: [{ op: "zoom", range: "1W" }] } }));
    const queuedText = queuedReported ? textOf(queuedReported) : "";
    check(
      "a queued change answers with the chart's last report and its plain Vela link, never the session's follow link",
      /Last report: The chart shows ETH on Hyperliquid/.test(queuedText) &&
        queuedText.includes("https://vela.luxalgo.com/chart?symbol=hyperliquid%3AETH&tf=4h") &&
        !queuedText.includes("session=") &&
        !queuedText.includes(s2.readKey),
      queuedText.slice(-160),
    );

    app.setEnabled(false);
    const fallback = await mcp.callTool({ name: "chart_open", arguments: { symbol: "ETH" } });
    check(
      "when the app answers 404 (chart sessions off), chart_open falls back to a chart in memory",
      !fallback.isError && /^ch_/.test(fallback.structuredContent?.chart_id ?? "") && !fallback._meta?.["luxalgo/chart"],
      fallback.structuredContent?.chart_id,
    );
    const gone = await mcp.callTool({ name: "chart_command", arguments: { chart_id: chartId, ops: [{ op: "clear_drawings" }] } });
    check("when the app no longer knows a session, chart_command says the chart is gone", gone.isError === true && /No open chart/.test(textOf(gone)));

    await app.close();
    const unreachable = await mcp.callTool({ name: "chart_open", arguments: { symbol: "SOL" } });
    check(
      "when the app cannot be reached, chart_open falls back to a chart in memory",
      !unreachable.isError && /^ch_/.test(unreachable.structuredContent?.chart_id ?? ""),
      unreachable.structuredContent?.chart_id,
    );
  } finally {
    await mcp.close().catch(() => {});
    entry.stop();
    await app.close().catch(() => {});
  }
}

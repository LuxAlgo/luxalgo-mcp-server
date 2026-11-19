/*
  The member's open Vela chart, read and changed by their AI assistant (opt-in:
  LUXALGO_CHART_CONTROL_TOOLS=on or a Vercel preview): its market, timeframe,
  look and layout, and drawings.

  1. The server under test: when it lists these tools, an anonymous read and an
     anonymous change meet the sign-in challenge (401 hosted, in-band on stdio).
  2. A node-http entry this suite starts with the tools on: the standard and the
     ChatGPT addresses list them, protected, with their annotations (removing
     drawings is the one marked destructive) and copy; anonymous calls are
     refused with 401; the Claude address lists none of them and its tool list
     is byte for byte the one under review.
  3. A stdio entry signed in to a stand-in for the app's route (a local server
     that takes the bodies the app takes and refuses what it refuses): a read in
     words, a change sent in the app's own names with only what was asked, the
     answers for no open tab, a chart that could not do it, a plan limit, a
     timeframe no chart has and the app's switch being off, and drawings drawn
     and removed. Calls the tool can refuse itself never reach the app. The
     stand-in records any call outside the app's MCP allowlist for these tools,
     and the suite fails if there is one.
*/
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { VELA_CHART } from "./surface.mjs";
import { CLAUDE_TOOLS_SHA256 } from "./claude-surface.mjs";

const TOKEN = "stand-in-token";
const READ = ["vela_read_chart", {}];
const CHANGE = ["vela_set_chart", { charts: [{ symbol: "BINANCE:ETHUSDT", timeframe: "15m" }] }];

export async function run({ client, check, httpUrl }) {
  await underTest(client, check, httpUrl);
  await addresses(check);
  await signedIn(check);
}

// ── 1. the server under test ────────────────────────────────────────────────

async function underTest(client, check, httpUrl) {
  const { tools } = await client.listTools();
  if (!tools.some((t) => VELA_CHART.includes(t.name))) {
    console.log("(chart control tools are off on the server under test; set LUXALGO_CHART_CONTROL_TOOLS=on to check them there too)");
    return;
  }
  for (const [name, args] of [READ, CHANGE]) {
    if (httpUrl) {
      const response = await post(httpUrl, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      const challenge = response.headers.get("www-authenticate") ?? "";
      check(
        `hosted ${name} without a token is refused at the transport (401 + WWW-Authenticate)`,
        response.status === 401 && /^Bearer error="invalid_token", /.test(challenge),
        `${response.status} ${challenge.slice(0, 100)}`,
      );
    } else {
      const result = await client.callTool({ name, arguments: args });
      const challenge = result._meta?.["mcp/www_authenticate"]?.[0] ?? "";
      check(
        `stdio ${name} without a sign-in answers the in-band OAuth challenge and changes nothing`,
        result.isError === true && /resource_metadata=/.test(challenge) && /npx -y @luxalgo\/mcp login/.test(result.content?.[0]?.text ?? ""),
        challenge.slice(0, 100),
      );
    }
  }
}

// ── 2. the three addresses ──────────────────────────────────────────────────

async function addresses(check) {
  const entry = await startHttpEntry();
  try {
    const standard = { url: entry.url };
    const openai = { url: `${entry.url}/openai` };
    const claude = { url: entry.url, host: `claude.${new URL(entry.url).host}` };
    const standardTools = await rpc(standard, "tools/list", {});
    const openaiTools = await rpc(openai, "tools/list", {});
    const claudeTools = await rpc(claude, "tools/list", {});
    const names = (list) => (list?.tools ?? []).map((t) => t.name);

    check(
      `with the chart control tools on, the standard address lists all ${VELA_CHART.length} of them, each asking for a LuxAlgo sign-in`,
      VELA_CHART.every((name) => {
        const tool = standardTools?.tools?.find((t) => t.name === name);
        return tool?.securitySchemes?.some((s) => s.type === "oauth2") && / Requires signing in with a LuxAlgo account \(OAuth\)\.$/.test(tool.description);
      }),
      `${names(standardTools).filter((n) => VELA_CHART.includes(n)).length} of ${VELA_CHART.length}`,
    );
    check("the ChatGPT address lists them too", VELA_CHART.every((name) => names(openaiTools).includes(name)), names(openaiTools).filter((n) => VELA_CHART.includes(n)).join(", "));
    const digest = createHash("sha256").update(JSON.stringify(claudeTools?.tools ?? [])).digest("hex");
    check(
      "the Claude address lists none of them and stays byte for byte the tool list under review",
      names(claudeTools).every((n) => !VELA_CHART.includes(n)) && digest === CLAUDE_TOOLS_SHA256,
      `${claudeTools?.tools?.length} tools, sha256 ${digest.slice(0, 12)}…`,
    );

    const statuses = [];
    for (const [name, args] of [READ, CHANGE]) {
      const response = await post(standard.url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      statuses.push(`${name} ${response.status}`);
    }
    check("on the standard address, an anonymous read and change are refused with 401", statuses.every((s) => s.endsWith(" 401")), statuses.join("; "));

    const tool = (name) => standardTools?.tools?.find((t) => t.name === name) ?? {};
    const a = (name) => tool(name).annotations ?? {};
    const props = (name) => Object.keys(tool(name).inputSchema?.properties ?? {});
    check(
      "reading is read-only; changing, drawing and removing are not, and all four reach outside (the member's browser)",
      a("vela_read_chart").readOnlyHint === true &&
        ["vela_set_chart", "vela_draw_on_chart", "vela_remove_drawings"].every((n) => a(n).readOnlyHint === false) &&
        VELA_CHART.every((n) => a(n).openWorldHint === true),
      VELA_CHART.map((n) => `${n} ${JSON.stringify(a(n))}`).join("; "),
    );
    check(
      "only removing drawings is marked destructive",
      VELA_CHART.every((n) => a(n).destructiveHint === (n === "vela_remove_drawings")),
    );
    check("every one of them has a title", VELA_CHART.every((n) => typeof tool(n).title === "string" && a(n).title === tool(n).title));
    const chartProps = Object.keys(tool("vela_set_chart").inputSchema?.properties?.charts?.items?.properties ?? {});
    check(
      "vela_set_chart takes a layout and, per chart, a market, a timeframe, a chart type, a session, a scale and the dates on screen, and no indicator",
      props("vela_set_chart").join() === "layout,charts" &&
        ["slot", "symbol", "timeframe", "chart_type", "session", "scale", "visible_range"].every((p) => chartProps.includes(p)) &&
        chartProps.every((p) => !/indicator/.test(p)) &&
        (tool("vela_set_chart").inputSchema?.required ?? []).length === 0,
      chartProps.join(", "),
    );
    check(
      "vela_draw_on_chart needs its drawings; vela_read_chart takes nothing",
      (tool("vela_draw_on_chart").inputSchema?.required ?? []).join() === "drawings" && props("vela_read_chart").length === 0,
    );
    check(
      "each says the member's Vela tab must be open and visible, and that it is the member's own Vela, not the chart in the chat",
      VELA_CHART.every((n) => /open and visible/.test(tool(n).description) && /has open right now in Vela/.test(tool(n).description)) &&
        /chart_open/.test(tool("vela_read_chart").description) &&
        /chart_open and chart_command/.test(tool("vela_set_chart").description),
    );
    check(
      "the changing tools say they carry no prices, and drawing says never to draw at guessed prices",
      /no prices/.test(tool("vela_read_chart").description) && /no prices/.test(tool("vela_set_chart").description) && /never at guessed ones/.test(tool("vela_draw_on_chart").description),
    );
    const copy = VELA_CHART.map((n) => `${tool(n).title} ${tool(n).description}`).join(" ");
    const banned = [/QuantCharts/, /Quant AI/, /\bpane\b/i, /TradingView/, /the company behind/i, /AI trading & charting/i];
    check(
      "their copy introduces Vela as our next-generation charting platform, names Quant our coding agent, and has none of the retired terms",
      /Vela, our next-generation charting platform/.test(copy) && /Quant, our coding agent/.test(copy) && banned.every((re) => !re.test(copy)),
      banned.filter((re) => re.test(copy)).join(", ") || "clean",
    );
  } finally {
    entry.stop();
  }
}

// ── 3. signed in, against a stand-in for the app ─────────────────────────────

async function signedIn(check) {
  const app = await startStandIn();
  const dir = await mkdtemp(join(tmpdir(), "luxalgo-vela-chart-"));
  const authFile = join(dir, "auth.json");
  await writeFile(
    authFile,
    JSON.stringify({
      version: 1,
      issuer: `${app.origin}/api/auth`,
      resource: "https://mcp.luxalgo.com/mcp",
      tokens: { access_token: TOKEN, token_type: "Bearer", obtainedAt: Date.now() },
    }),
  );
  const member = new Client({ name: "vela-chart-smoke", version: "0" });
  await member.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: { ...getDefaultEnvironment(), LUXALGO_APP_ORIGIN: app.origin, LUXALGO_MCP_AUTH_FILE: authFile, LUXALGO_CHART_CONTROL_TOOLS: "on" },
      stderr: "ignore",
    }),
  );
  const call = async (name, args = {}) => {
    const result = await member.callTool({ name, arguments: args });
    return { isError: result.isError === true, text: result.content?.[0]?.text ?? "", data: result.structuredContent ?? {} };
  };
  const { state } = app;
  const sent = () => state.calls.at(-1)?.body;
  try {
    const read = await call("vela_read_chart");
    check(
      "vela_read_chart says what the member's Vela shows in words: each chart's market, timeframe, type, indicators and dates, and which one they are on",
      !read.isError &&
        JSON.stringify(sent()) === '{"op":"read"}' &&
        /shows 2 charts \(layout 2h\)/.test(read.text) &&
        /Chart 0 \(the one the member is working on\): BINANCE:BTCUSDT, 1h, as candles\. Indicators: Volume and Smart Money Concepts \[LuxAlgo\]\./.test(read.text) &&
        /Chart 1: AAPL, 1D, as Heikin Ashi candles, extended hours, on a logarithmic scale\. No indicators\./.test(read.text) &&
        /On screen: 2026-11-01 to 2026-11-19/.test(read.text) &&
        read.data.status === "ok" &&
        read.data.active_slot === 0 &&
        read.data.charts?.[1]?.chart_type === "heikinashi",
      read.text.slice(0, 220),
    );

    const changed = await call("vela_set_chart", {
      layout: "2h",
      charts: [
        { slot: 0, symbol: "BINANCE:ETHUSDT", timeframe: "15m" },
        { slot: 1, chart_type: "line", scale: { log: true }, visible_range: { preset: "3M" } },
      ],
    });
    check(
      "vela_set_chart sends the change in the app's own names, with only what was asked for",
      JSON.stringify(sent()) ===
        '{"op":"set","state":{"layout":"2h","charts":[{"slot":0,"symbol":"BINANCE:ETHUSDT","timeframe":"15m"},{"slot":1,"scale":{"log":true},"chartType":"line","visibleRange":{"preset":"3M"}}]}}',
      JSON.stringify(sent()),
    );
    check(
      "it answers with what the chart shows afterwards, and says when a sync link had to be switched off for two charts to differ",
      !changed.isError && /^Done\./.test(changed.text) && /symbol link is off/.test(changed.text) && /Chart 0 \(the one the member is working on\): BINANCE:ETHUSDT, 15m/.test(changed.text) && changed.data.released_sync?.[0] === "symbol",
      changed.text.slice(0, 200),
    );

    const before = state.calls.length;
    const nothing = await call("vela_set_chart", {});
    const twoRanges = await call("vela_set_chart", { charts: [{ visible_range: { preset: "1M", from: "2026-01-01" } }] });
    const onlySlot = await call("vela_set_chart", { charts: [{ slot: 1 }] });
    const noGroups = await call("vela_remove_drawings", {});
    check(
      "a change that asks for nothing, a range given two ways, a chart named with nothing to change and a removal that names nothing are refused before the app is asked",
      [nothing, twoRanges, onlySlot, noGroups].every((r) => r.isError && /^Nothing (changed|removed)/.test(r.text)) && state.calls.length === before,
      [nothing, twoRanges, onlySlot, noGroups].map((r) => r.text.slice(0, 50)).join(" | "),
    );

    state.mode = "no_open_chart";
    const noTab = await call(...CHANGE);
    check(
      "with no visible Vela tab, it says nothing changed and asks the member to open Vela, keep it visible and ask again in a minute",
      !noTab.isError && noTab.data.status === "no_open_chart" && /Nothing changed/.test(noTab.text) && /vela\.luxalgo\.com\/chart/.test(noTab.text) && /visible/.test(noTab.text) && /in a minute/.test(noTab.text),
      noTab.text.slice(0, 160),
    );
    state.mode = "failed";
    const failed = await call(...CHANGE);
    check(
      "a change the chart could not make is an error that gives the chart's reason and what it still shows",
      failed.isError && failed.data.status === "failed" && /is not a market Vela serves/.test(failed.text) && /BINANCE:BTCUSDT, 1h/.test(failed.text),
      failed.text.slice(0, 200),
    );
    state.mode = "timeout";
    const late = await call(...CHANGE);
    check("a tab that did not answer in time is said to be unknown, with a read to check", late.data.status === "timeout" && /vela_read_chart/.test(late.text), late.text.slice(0, 120));
    state.mode = "plan";
    const plan = await call("vela_set_chart", { charts: [{ timeframe: "7m" }] });
    check(
      "a timeframe the member's plan does not include comes back as the app words it, with where to upgrade",
      plan.isError && /plan does not include this \(customTimeframes\)/.test(plan.text) && /preset timeframes/.test(plan.text) && /account\/plan/.test(plan.text),
      plan.text.slice(0, 200),
    );
    state.mode = "ok";
    const seconds = await call("vela_set_chart", { charts: [{ timeframe: "30s" }] });
    check(
      "a timeframe no chart has is refused with the app's reason",
      seconds.isError && /^Nothing changed: "30s" is shorter than a minute/.test(seconds.text),
      seconds.text.slice(0, 120),
    );

    const drawn = await call("vela_draw_on_chart", {
      slot: 0,
      title: "Range plan",
      drawings: [
        { type: "level", points: [{ time: "2026-11-01 00:00", price: 70000 }], label: "Resistance", tone: "bearish" },
        { type: "zone", points: [{ time: "2026-10-25 00:00", price: 62000 }, { time: 1794000000000, price: 60000 }], extend: true, end_time: "2026-11-10 00:00" },
      ],
    });
    check(
      "vela_draw_on_chart passes the drawings on as given and answers with the group they belong to",
      !drawn.isError &&
        sent()?.op === "draw" &&
        sent()?.drawing?.title === "Range plan" &&
        sent()?.drawing?.drawings?.[1]?.end_time === "2026-11-10 00:00" &&
        sent()?.drawing?.drawings?.[1]?.points?.[1]?.time === 1794000000000 &&
        /Drew 2 drawings on the member's chart, as group "scenario-4k2x"/.test(drawn.text) &&
        drawn.data.drawn?.group === "scenario-4k2x",
      drawn.text.slice(0, 160),
    );
    const removed = await call("vela_remove_drawings", { slot: 0, groups: ["scenario-4k2x"] });
    check(
      "vela_remove_drawings removes the group it is given and says how many drawings went",
      !removed.isError && JSON.stringify(sent()) === '{"op":"remove","removal":{"slot":0,"groups":["scenario-4k2x"]}}' && /^Removed 2 drawings\./.test(removed.text) && removed.data.removed === 2,
      removed.text.slice(0, 120),
    );
    const none = await call("vela_remove_drawings", { all: true, all_charts: true });
    check("with nothing of an assistant's on the chart, it says so and that the member's own drawings are never touched", !none.isError && /nothing was removed/.test(none.text) && /never touched/.test(none.text), none.text.slice(0, 120));

    state.mode = "off";
    const off = await call("vela_read_chart");
    check("while the app has chart control switched off (404), the tools say it is not available yet", off.isError && /not available yet/.test(off.text), off.text);
    state.mode = "ok";

    check(
      "every call carried the member's token and stayed on the app's allowlist for these tools",
      state.violations.length === 0 && state.calls.length > 0 && state.calls.every((c) => c.auth === `Bearer ${TOKEN}`),
      state.violations.join(", ") || `${state.calls.length} calls`,
    );
  } finally {
    await member.close();
    app.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

// ── the stand-in app ─────────────────────────────────────────────────────────

/** The one route the app lets these tools reach with the member's token. */
const ALLOWED = [["POST", /^\/api\/agents\/chart$/]];

const CHART_KEYS = ["slot", "symbol", "timeframe", "chartType", "session", "scale", "visibleRange"];
const DRAWING_KEYS = ["type", "points", "time", "label", "text", "tone", "dash", "extend", "end_time", "arrow", "stop", "target"];
const LAYOUT = /^(1|2h|2v|4|8|g[1-4]x[1-4]|big-(left|top)-[23]|big-(right|bottom)-2)$/;
/** The app's timeframes: whole minutes, hours, days, weeks or months. */
const TIMEFRAME = /^(\d+)?\s*(m|h|d|w|M)?$/i;

/** Why the app would refuse this body's shape (its contract), or null. */
function bodyProblem(body) {
  if (!body || typeof body !== "object" || !["read", "set", "draw", "remove"].includes(body.op)) return "op";
  if (Object.keys(body).some((key) => !["op", "state", "drawing", "removal"].includes(key))) return "unknown field";
  if (body.op === "set") {
    const state = body.state;
    if (!state || Object.keys(state).some((key) => !["layout", "charts"].includes(key))) return "state";
    if (state.charts !== undefined && (!Array.isArray(state.charts) || state.charts.some((chart) => Object.keys(chart).some((key) => !CHART_KEYS.includes(key))))) return "state.charts";
    if (state.layout === undefined && !state.charts?.length) return "state is empty";
  }
  if (body.op === "draw") {
    const drawing = body.drawing;
    if (!drawing || !Array.isArray(drawing.drawings) || drawing.drawings.length < 1) return "drawing";
    if (Object.keys(drawing).some((key) => !["slot", "title", "drawings"].includes(key))) return "drawing fields";
    if (drawing.drawings.some((d) => Object.keys(d).some((key) => !DRAWING_KEYS.includes(key)))) return "drawing.drawings";
  }
  if (body.op === "remove") {
    const removal = body.removal;
    if (!removal || Object.keys(removal).some((key) => !["slot", "groups", "all", "all_charts"].includes(key))) return "removal";
  }
  return null;
}

const chartNow = (overrides = {}) => ({
  slot: 0,
  symbol: "BINANCE:BTCUSDT",
  timeframe: "1h",
  chartType: "candles",
  scale: { mode: "price", log: false, invert: false },
  visibleRange: { from: "2026-11-01T00:00:00.000Z", to: "2026-11-19T15:00:00.000Z" },
  indicators: ["Volume", "Smart Money Concepts [LuxAlgo]"],
  clock: "Etc/UTC",
  quantDrawings: 0,
  ...overrides,
});

async function startStandIn() {
  const state = { calls: [], violations: [], mode: "ok" };
  const second = chartNow({ slot: 1, symbol: "AAPL", timeframe: "1D", chartType: "heikinashi", session: "extended", scale: { mode: "price", log: true, invert: false }, indicators: [], clock: "America/New_York" });
  const shows = (first = {}) => ({ layout: "2h", activeSlot: 0, charts: [chartNow(first), second] });

  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, "http://stand-in");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    const send = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status < 300 ? { data } : { errors: [data] }));
    };
    state.calls.push({ method: req.method, path: url.pathname, auth: req.headers.authorization, body });
    if (!ALLOWED.some(([method, re]) => method === req.method && re.test(url.pathname))) {
      state.violations.push(`${req.method} ${url.pathname}`);
      return send(404, { message: "Not found" });
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: "unauthorized" });
    if (state.mode === "off") return send(404, { message: "Not available" });
    const problem = bodyProblem(body);
    if (problem) {
      state.violations.push(`body: ${problem}`);
      return send(400, { message: "body validation error" });
    }
    if (body.op === "set") {
      if (body.state.layout !== undefined && !LAYOUT.test(body.state.layout)) return send(400, { message: "Not a valid layout." });
      for (const chart of body.state.charts ?? []) {
        if (chart.timeframe !== undefined && !TIMEFRAME.test(chart.timeframe)) {
          return send(400, { message: `"${chart.timeframe}" is shorter than a minute, and the chart's shortest timeframe is 1 minute ("1"): there are no seconds or tick timeframes.` });
        }
      }
      if (state.mode === "plan") {
        return send(403, {
          message: "Not enough permissions (customTimeframes): your plan has the preset timeframes (1m, 5m, 15m, 30m, 1h, 4h, 1D, 1W, 1M); any other timeframe is a custom one",
          details: { permission: "customTimeframes" },
        });
      }
    }
    if (state.mode === "no_open_chart" || state.mode === "timeout") return send(200, { status: state.mode });
    if (state.mode === "failed") {
      return send(200, { status: "failed", error: '"TVC:GOLD" is not a market Vela serves, so nothing was changed. Use the bare ticker, or a venue prefix Vela reads.', state: shows() });
    }
    if (body.op === "read") return send(200, { status: "ok", state: shows() });
    if (body.op === "set") {
      const first = body.state.charts?.find((chart) => (chart.slot ?? 0) === 0) ?? {};
      const symbols = new Set((body.state.charts ?? []).map((chart) => chart.symbol).filter(Boolean));
      return send(200, {
        status: "ok",
        state: shows({ ...(first.symbol ? { symbol: first.symbol } : {}), ...(first.timeframe ? { timeframe: first.timeframe } : {}) }),
        ...(body.state.charts?.length > 1 && symbols.size >= 1 ? { releasedSync: ["symbol"] } : {}),
      });
    }
    if (body.op === "draw") {
      const count = body.drawing.drawings.length;
      return send(200, { status: "ok", state: shows({ quantDrawings: count }), drawn: { slot: body.drawing.slot ?? 0, group: "scenario-4k2x", drawings: count } });
    }
    return send(200, { status: "ok", state: shows(), removed: body.removal.groups?.length ? 2 : 0 });
  });
  const port = await freePort();
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${port}`, state, stop: () => server.close() };
}

// ── plumbing ─────────────────────────────────────────────────────────────────

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** A node-http entry with every opt-in tool on: the Claude address stays as reviewed with all of them. */
async function startHttpEntry() {
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port),
    MCP_RESOURCE: `http://localhost:${port}/mcp`,
    LUXALGO_CHART_CONTROL_TOOLS: "on",
    LUXALGO_ACCOUNT_TOOLS: "on",
    LUXALGO_CHART_TOOLS: "on",
  };
  delete env.VERCEL_ENV;
  const child = spawn(process.execPath, ["dist/entries/node-http.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
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

function post(url, payload, host) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(host ? { "x-forwarded-host": host } : {}),
    },
    body: JSON.stringify(payload),
  });
}

async function rpc({ url, host }, method, params) {
  const response = await post(url, { jsonrpc: "2.0", id: 1, method, params }, host);
  const text = await response.text();
  return JSON.parse(text.startsWith("{") ? text : (text.match(/^data: (.*)$/m)?.[1] ?? "{}")).result;
}

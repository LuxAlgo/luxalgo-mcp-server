/*
  The member's watchlists, saved layouts and alerts (opt-in: LUXALGO_ACCOUNT_TOOLS=on
  or a Vercel preview; the app routes they call are not in production yet).

  1. The server under test: when it lists these tools, an anonymous read and an
     anonymous write meet the sign-in challenge (401 hosted, in-band on stdio).
  2. A node-http entry this suite starts with the tools on: the standard and the
     ChatGPT addresses list them, protected, with their schemas and annotations;
     anonymous calls there are refused with 401; the Claude address lists none of
     them and its tool list is byte for byte the one under review.
  3. A stdio entry signed in to a stand-in for the app's routes (a local server
     that speaks the app's contracts and refuses anything they refuse): the
     success paths, a watchlist save retried after another device saved first
     (409), plan limits relayed as the app words them (403), an alert created
     for a member with no in-app channel saying it notifies no one, and the
     prices an alert's history may and may not show. The stand-in also records
     any call the app's MCP allowlist would not take (a DELETE, a destination
     list), and the suite fails if there is one.
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
import { ACCOUNT_PROTECTED } from "./surface.mjs";
import { CLAUDE_TOOLS_SHA256 } from "./claude-surface.mjs";

const TOKEN = "stand-in-token";
const READ = "watchlists_list";
const WRITE = ["alerts_create_price", { symbol: "binance:BTCUSDT", condition: "cross_up", level: 100000 }];

export async function run({ client, check, httpUrl }) {
  await underTest(client, check, httpUrl);
  await addresses(check);
  await signedIn(check);
}

// ── 1. the server under test ────────────────────────────────────────────────

async function underTest(client, check, httpUrl) {
  const { tools } = await client.listTools();
  if (!tools.some((t) => ACCOUNT_PROTECTED.includes(t.name))) {
    console.log("(account tools are off on the server under test; set LUXALGO_ACCOUNT_TOOLS=on to check them there too)");
    return;
  }
  for (const [name, args] of [[READ, {}], WRITE]) {
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
      "with the account tools on, the standard address lists all 11 of them, each asking for a LuxAlgo sign-in",
      ACCOUNT_PROTECTED.every((name) => {
        const tool = standardTools?.tools?.find((t) => t.name === name);
        return tool?.securitySchemes?.some((s) => s.type === "oauth2") && / Requires signing in with a LuxAlgo account \(OAuth\)\.$/.test(tool.description);
      }),
      `${names(standardTools).filter((n) => ACCOUNT_PROTECTED.includes(n)).length} of ${ACCOUNT_PROTECTED.length}`,
    );
    check(
      "the ChatGPT address lists them too",
      ACCOUNT_PROTECTED.every((name) => names(openaiTools).includes(name)),
      names(openaiTools).filter((n) => ACCOUNT_PROTECTED.includes(n)).join(", "),
    );
    const digest = createHash("sha256").update(JSON.stringify(claudeTools?.tools ?? [])).digest("hex");
    check(
      "the Claude address lists none of them and stays byte for byte the tool list under review",
      names(claudeTools).every((n) => !ACCOUNT_PROTECTED.includes(n)) && digest === CLAUDE_TOOLS_SHA256,
      `${claudeTools?.tools?.length} tools, sha256 ${digest.slice(0, 12)}…`,
    );

    for (const [where, address] of [
      ["standard", standard],
      ["ChatGPT", openai],
    ]) {
      const statuses = [];
      for (const [name, args] of [[READ, {}], WRITE]) {
        const response = await post(address.url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
        statuses.push(`${name} ${response.status}`);
      }
      check(`on the ${where} address, an anonymous read and write are refused with 401`, statuses.every((s) => s.endsWith(" 401")), statuses.join("; "));
    }

    // Schemas and annotations, as an AI client reads them.
    const tool = (name) => standardTools?.tools?.find((t) => t.name === name) ?? {};
    const props = (name) => Object.keys(tool(name).inputSchema?.properties ?? {});
    const required = (name) => (tool(name).inputSchema?.required ?? []).slice().sort().join();
    const reads = ["watchlists_list", "layouts_list", "alerts_list", "alerts_history"];
    const writes = ACCOUNT_PROTECTED.filter((n) => !reads.includes(n));
    check(
      "reads are marked read-only; writes are not, and say they reach outside (openWorldHint)",
      reads.every((n) => tool(n).annotations?.readOnlyHint === true) &&
        writes.every((n) => tool(n).annotations?.readOnlyHint === false && tool(n).annotations?.openWorldHint === true),
    );
    check(
      "no tool deletes anything; only removing a symbol from a watchlist is marked destructive",
      writes.every((n) => tool(n).annotations?.destructiveHint === (n === "watchlists_remove_symbols")) &&
        ACCOUNT_PROTECTED.every((n) => !/delete/.test(n)),
    );
    check(
      "every one of them has a title",
      ACCOUNT_PROTECTED.every((n) => typeof tool(n).title === "string" && tool(n).annotations?.title === tool(n).title),
    );
    check(
      "watchlists_add_symbols takes a list id and markets; alerts_create_price a market, a condition and a level, and optionally a chart to draw on",
      required("watchlists_add_symbols") === "symbols,watchlist_id" &&
        required("alerts_create_price") === "condition,level,symbol" &&
        props("alerts_create_price").includes("chart_id") &&
        JSON.stringify(tool("alerts_create_price").inputSchema?.properties?.condition?.enum) === '["cross","cross_up","cross_down","above","below"]',
      `${required("watchlists_add_symbols")} | ${required("alerts_create_price")}`,
    );
    check(
      "alerts_create_custom takes a built-in indicator or a Library indicator, and can preview without creating",
      ["symbol", "timeframe", "indicator", "library", "frequency", "preview_only"].every((p) => props("alerts_create_custom").includes(p)),
      props("alerts_create_custom").join(", "),
    );
    const copy = ACCOUNT_PROTECTED.map((n) => `${tool(n).title} ${tool(n).description}`).join(" ");
    const banned = [/indicator alerts?/i, /strategy alerts?/i, /Watchers/, /Alert Agents?/i, /Signal Alerts?/i, /Price alert/, /Custom alert/, /QuantCharts/, /\bpane\b/i, /Quant AI/];
    check(
      "their copy names Price Alerts and Custom Alerts and none of the retired terms",
      /Price Alert/.test(copy) && /Custom Alert/.test(copy) && banned.every((re) => !re.test(copy)),
      banned.filter((re) => re.test(copy)).join(", ") || "clean",
    );
  } finally {
    entry.stop();
  }
}

// ── 3. signed in, against a stand-in for the app ─────────────────────────────

async function signedIn(check) {
  const app = await startStandIn();
  const dir = await mkdtemp(join(tmpdir(), "luxalgo-account-tools-"));
  const authFile = join(dir, "auth.json");
  // The local store a `login` would write, for the stand-in's issuer; an opaque token that never expires.
  await writeFile(
    authFile,
    JSON.stringify({
      version: 1,
      issuer: `${app.origin}/api/auth`,
      resource: "https://mcp.luxalgo.com/mcp",
      tokens: { access_token: TOKEN, token_type: "Bearer", obtainedAt: Date.now() },
    }),
  );
  const member = new Client({ name: "account-tools-smoke", version: "0" });
  await member.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      // Chart tools on too, so a Price Alert can draw its level on an open chart (kept in memory: the stand-in has no chart sessions).
      env: {
        ...getDefaultEnvironment(),
        LUXALGO_APP_ORIGIN: app.origin,
        LUXALGO_MCP_AUTH_FILE: authFile,
        LUXALGO_ACCOUNT_TOOLS: "on",
        LUXALGO_CHART_TOOLS: "on",
      },
      stderr: "ignore",
    }),
  );
  const call = async (name, args = {}) => {
    const result = await member.callTool({ name, arguments: args });
    return { isError: result.isError === true, text: result.content?.[0]?.text ?? "", data: result.structuredContent ?? {} };
  };
  const { state } = app;
  try {
    // Watchlists.
    const listed = await call("watchlists_list");
    check(
      "watchlists_list names each list with its markets in words and a Vela link per symbol",
      !listed.isError &&
        listed.text.includes('"Crypto" (id wl_1)') &&
        listed.text.includes("BTC on Hyperliquid") &&
        listed.data.watchlists?.[0]?.symbols?.[0]?.chart_url === "https://vela.luxalgo.com/chart?symbol=hyperliquid:BTC&tf=D",
      listed.text.slice(0, 160),
    );

    state.conflicts = 1;
    const added = await call("watchlists_add_symbols", { watchlist_id: "wl_1", symbols: ["binance:ETHUSDT", "NASDAQ:aapl", "hyperliquid:BTC"] });
    const saved = state.watchlists.get("wl_1");
    const patches = state.calls.filter((c) => c.method === "PATCH");
    check(
      "adding symbols after another device saved the list reads it again and saves once on top of that save",
      !added.isError &&
        patches.length === 2 &&
        patches[1].body.ifUpdatedAt === patches[1].listUpdatedAt &&
        saved.symbols.some((r) => r.symbol === "OTHERDEVICE") &&
        saved.symbols.some((r) => r.symbol === "ETHUSD" && r.venue?.source === "binance" && r.venue?.ticker === "ETHUSDT") &&
        saved.symbols.some((r) => r.symbol === "AAPL" && r.category === "Stocks" && !r.venue),
      `${patches.length} saves; ${added.text.slice(0, 160)}`,
    );
    check(
      "a market already in the list is left as it is and said so",
      /Already there: BTC on Hyperliquid/.test(added.text) && saved.symbols.filter((r) => r.venue?.source === "hyperliquid").length === 1,
      added.text,
    );

    state.conflicts = 5;
    const stale = await call("watchlists_add_symbols", { watchlist_id: "wl_1", symbols: ["fx:EURUSD"] });
    check(
      "when the list keeps changing elsewhere, nothing is saved and the member is told to try again",
      stale.isError && /changed on another device/.test(stale.text) && !state.watchlists.get("wl_1").symbols.some((r) => r.symbol === "EURUSD"),
      stale.text,
    );
    state.conflicts = 0;

    const bare = await call("watchlists_add_symbols", { watchlist_id: "wl_1", symbols: ["AAPL"] });
    check("a bare stock ticker is not guessed onto a venue: the tool asks for its source", bare.isError && /edgx:AAPL/.test(bare.text), bare.text.slice(0, 100));

    const removed = await call("watchlists_remove_symbols", { watchlist_id: "wl_1", symbols: ["AAPL", "binance:SOLUSDT"] });
    check(
      "removing by a bare symbol takes it out; a market not in the list is named as not found",
      !removed.isError && /Removed AAPL/.test(removed.text) && /Not in the list: binance:SOLUSDT/.test(removed.text) &&
        !state.watchlists.get("wl_1").symbols.some((r) => r.symbol === "AAPL"),
      removed.text,
    );

    const missing = await call("watchlists_add_symbols", { watchlist_id: "wl_nope", symbols: ["binance:BTCUSDT"] });
    check("an unknown watchlist id says so and points at watchlists_list", missing.isError && /watchlists_list/.test(missing.text), missing.text);

    state.limit = "maxWatchlists";
    const limited = await call("watchlists_create", { name: "One too many" });
    check(
      "a plan limit comes back as the app words it, with where to upgrade, and nothing is created",
      limited.isError && /plan does not include this \(maxWatchlists\)/.test(limited.text) && /your plan allows up to 3 watchlists/.test(limited.text) && /account\/plan/.test(limited.text) && state.watchlists.size === 1,
      limited.text.slice(0, 200),
    );
    state.limit = null;
    const created = await call("watchlists_create", { name: "Majors", symbols: ["coinbase:BTC-USD", "fx:EURUSD"] });
    check(
      "watchlists_create makes the list with its first symbols and gives its id",
      !created.isError && /Created the watchlist "Majors"/.test(created.text) && state.watchlists.size === 2,
      created.text,
    );

    // Layouts.
    const layouts = await call("layouts_list");
    check(
      "layouts_list gives each saved layout's name and its Open in Vela link",
      !layouts.isError && layouts.text.includes('"Morning scan" (id ws_1)') && layouts.data.layouts?.[0]?.chart_url === "https://vela.luxalgo.com/chart/ws_1",
      layouts.text,
    );

    // Price Alerts.
    state.destinations = [];
    const noChannel = await call("alerts_create_price", { symbol: "binance:BTCUSDT", condition: "cross_up", level: "100,000.50" });
    const firstRule = state.lastCreated;
    check(
      "a Price Alert for a member with no in-app channel is created with no channel, and the result says it notifies no one",
      !noChannel.isError && firstRule?.actions?.length === 0 && /notifies no one/.test(noChannel.text) && noChannel.data.notifies === "none",
      noChannel.text.slice(0, 200),
    );
    check(
      "the level reaches the app as a canonical decimal, on the market as the data server names it",
      firstRule?.condition?.level === "100000.5" &&
        firstRule?.scope?.market?.source === "binance" &&
        firstRule?.scope?.market?.symbol === "BTCUSDT" &&
        firstRule?.frequency?.kind === "once",
      JSON.stringify(firstRule?.condition),
    );
    state.destinations = [{ id: "dst_paused", kind: "inapp", status: "paused" }, { id: "dst_app", kind: "inapp", status: "active" }];
    const withChannel = await call("alerts_create_price", {
      symbol: "hyperliquid:ETH",
      condition: "below",
      level: 2500,
      frequency: "once_per_bar_close",
      timeframe: "4h",
    });
    check(
      "with an in-app channel, the alert notifies it and the result says so plainly",
      !withChannel.isError &&
        state.lastCreated?.actions?.[0]?.destinationId === "dst_app" &&
        state.lastCreated?.frequency?.tf === 240 &&
        /notifies the member in-app/.test(withChannel.text) &&
        withChannel.data.alert?.chart_url === "https://vela.luxalgo.com/chart?symbol=hyperliquid:ETH&tf=240",
      withChannel.text.slice(0, 220),
    );
    const opened = await member.callTool({ name: "chart_open", arguments: { symbol: "binance:BTCUSDT", timeframe: "1h" } });
    const chartId = opened.structuredContent?.chart_id;
    const drawn = await call("alerts_create_price", { symbol: "binance:BTCUSDT", condition: "cross_down", level: 90000, chart_id: chartId });
    const synced = await member.callTool({ name: "chart_sync", arguments: { chart_id: chartId, acked_seq: 0 } });
    const levelOp = synced.structuredContent?.ops?.find((op) => op.op === "add_level");
    check(
      "a Price Alert made with an open chart's id also draws its level on that chart",
      !drawn.isError && /drawn on the open chart/.test(drawn.text) && levelOp?.price === 90000,
      `${drawn.text.slice(-80)} | ${JSON.stringify(levelOp)}`,
    );
    const gone = await call("alerts_create_price", { symbol: "binance:BTCUSDT", condition: "cross", level: 80000, chart_id: "ch_unknown" });
    check(
      "with a chart that is not open any more, the alert is still created and the result says the level was not drawn",
      !gone.isError && /Created the Price Alert/.test(gone.text) && /not open any more/.test(gone.text),
      gone.text.slice(-90),
    );

    state.limit = "maxPriceAlerts";
    const tooMany = await call("alerts_create_price", { symbol: "binance:BTCUSDT", condition: "above", level: 1 });
    check(
      "a Price Alert past the plan's limit is relayed as the plan message and not created",
      tooMany.isError && /\(maxPriceAlerts\)/.test(tooMany.text) && /Upgrading/.test(tooMany.text),
      tooMany.text.slice(0, 160),
    );
    state.limit = null;

    // Custom Alerts.
    const createsBefore = state.calls.filter((c) => c.method === "POST" && c.path === "/api/alert-rules").length;
    const preview = await call("alerts_create_custom", {
      symbol: "binance:BTCUSDT",
      timeframe: "1h",
      indicator: { type: "rsi", settings: { length: 14 }, when: "crosses_above", than: 70 },
      preview_only: true,
    });
    const previewBody = state.calls.findLast((c) => c.path === "/api/alert-rules/preview")?.body;
    check(
      "a Custom Alert preview says in words how often it would have fired and creates nothing",
      !preview.isError &&
        /would have fired 12 times, about 0.4 per day/.test(preview.text) &&
        state.calls.filter((c) => c.method === "POST" && c.path === "/api/alert-rules").length === createsBefore,
      preview.text.slice(0, 200),
    );
    check(
      "the preview draft names the built-in by Vela's type and compares its line as asked",
      previewBody?.native?.type === "rsi" &&
        previewBody?.draft?.tf === 60 &&
        previewBody?.draft?.condition?.fn === "crossover" &&
        previewBody?.draft?.condition?.args?.[1]?.value === 70,
      JSON.stringify(previewBody?.draft?.condition),
    );
    const custom = await call("alerts_create_custom", {
      symbol: "binance:BTCUSDT",
      timeframe: "1h",
      library: { slug: "smart-money-concepts", alert_condition: "Bullish BOS" },
    });
    const customRule = state.lastCreated;
    check(
      "a Custom Alert from a Library indicator is created from the preview's rule, with the message the preview wrote",
      !custom.isError &&
        customRule?.type === "agent" &&
        customRule?.condition?.op === "pine" &&
        customRule?.actions?.[0]?.template === "The alert fired on {{market}}" &&
        /Created the Custom Alert/.test(custom.text) &&
        /notifies the member in-app/.test(custom.text),
      custom.text.slice(0, 200),
    );
    const both = await call("alerts_create_custom", { symbol: "binance:BTCUSDT", indicator: { type: "rsi", when: "above", than: 70 }, library: { slug: "x" } });
    check("a Custom Alert needs exactly one indicator", both.isError && /exactly one/.test(both.text), both.text);

    // List, pause, resume, history.
    const list = await call("alerts_list");
    check(
      "alerts_list describes each alert in words with its state and the plan usage the app reports",
      !list.isError && /Price Alert "BTCUSDT crosses above 100000.5"/.test(list.text) && /Plan usage: 4 Price Alerts on of the 5 the plan allows/.test(list.text),
      list.text.slice(0, 260),
    );
    const id = firstRule.id;
    const paused = await call("alerts_pause", { alert_id: id });
    const resumed = await call("alerts_resume", { alert_id: id });
    check(
      "an alert can be paused and turned back on",
      !paused.isError && /^Paused:/.test(paused.text) && /paused\.$/.test(paused.text) && !resumed.isError && /^Turned back on:/.test(resumed.text),
      `${paused.text.slice(0, 80)} | ${resumed.text.slice(0, 80)}`,
    );
    const history = await call("alerts_history", {});
    check(
      "alert history gives the fire price only for an exchange-fed crypto market, never a licensed one",
      !history.isError && history.text.includes("at 64123.5") && history.text.includes("in-app: sent") && !history.text.includes("190.12") && !JSON.stringify(history.data).includes("190.12"),
      history.text.slice(0, 220),
    );

    state.alertsOff = true;
    const off = await call("alerts_list");
    check("while the app's alerts are off for the account (404), the tools say so", off.isError && /not open on this account/.test(off.text), off.text);
    state.alertsOff = false;

    check(
      "every call carried the member's token, and none was outside what the app lets this server do (no delete, no destination list)",
      state.violations.length === 0 && state.calls.every((c) => c.auth === `Bearer ${TOKEN}`),
      state.violations.join("; ") || `${state.calls.length} calls`,
    );
  } finally {
    await member.close();
    app.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

// ── the stand-in app ─────────────────────────────────────────────────────────

/** The app's MCP allowlist for these tools (its bearer route policy): anything else is a violation. */
const ALLOWED = [
  ["GET", /^\/api\/quant\/watchlists$/],
  ["GET", /^\/api\/quant\/watchlists\/[^/]+$/],
  ["POST", /^\/api\/quant\/watchlists$/],
  ["PATCH", /^\/api\/quant\/watchlists\/[^/]+$/],
  ["GET", /^\/api\/quant\/workspaces$/],
  ["GET", /^\/api\/alert-rules$/],
  ["POST", /^\/api\/alert-rules$/],
  ["GET", /^\/api\/alert-rules\/[^/]+$/],
  ["POST", /^\/api\/alert-rules\/[^/]+\/(pause|resume)$/],
  ["POST", /^\/api\/alert-rules\/preview$/],
  ["GET", /^\/api\/alert-events$/],
  ["GET", /^\/api\/alert-destinations\/in-app$/],
];
const SOURCES = ["binance", "binance.us", "coinbase", "hyperliquid", "edgx", "fx", "commodities", "cme"];
const CATEGORIES = ["Crypto", "Forex", "Commodities", "Stocks", "ETFs"];
const CANONICAL = /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;
const MARKET_PART = /^[\x21-\x39\x3b-\x7b\x7d\x7e]{1,64}$/;
const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function rowProblem(row) {
  if (typeof row?.symbol !== "string" || !/^[A-Za-z0-9.!-]{1,32}$/.test(row.symbol)) return "symbol";
  if (!CATEGORIES.includes(row.category)) return "category";
  if (row.venue !== undefined && (!SOURCES.includes(row.venue.source) || !/^(?!.*\.\.)[A-Za-z0-9!_-][A-Za-z0-9.!/_-]{0,39}$/.test(row.venue.ticker))) return "venue";
  if (row.section !== undefined && (typeof row.section !== "string" || row.section.length > 80)) return "section";
  return null;
}

function frequencyProblem(f) {
  if (f?.kind === "once" || f?.kind === "once_per_minute") return null;
  if (f?.kind === "once_per_bar" || f?.kind === "once_per_bar_close") return Number.isInteger(f.tf) && f.tf >= 1 ? null : "frequency.tf";
  if (f?.kind === "every_time") return Number.isInteger(f.minIntervalMs) && f.minIntervalMs >= 1000 ? null : "frequency.minIntervalMs";
  return "frequency.kind";
}

/** The engine's rule checks this suite relies on, as strict as the app's. */
function ruleProblem(rule) {
  if (rule?.type !== "price" && rule?.type !== "agent") return "type";
  if (typeof rule.name !== "string" || rule.name.length < 1 || rule.name.length > 120) return "name";
  if (rule.scope?.kind !== "market" || !MARKET_PART.test(rule.scope.market?.source ?? "") || !MARKET_PART.test(rule.scope.market?.symbol ?? "")) return "scope";
  if (rule.type === "price") {
    if (!["cross", "cross_up", "cross_down", "above", "below"].includes(rule.condition?.kind)) return "condition.kind";
    if (!CANONICAL.test(rule.condition.level ?? "") || rule.condition.level === "0") return "condition.level";
  } else if (typeof rule.condition?.op !== "string") return "condition";
  if (!Array.isArray(rule.actions) || rule.actions.some((a) => typeof a.destinationId !== "string")) return "actions";
  return frequencyProblem(rule.frequency);
}

async function startStandIn() {
  const at = (minutes) => new Date(Date.UTC(2026, 10, 1, 12, minutes)).toISOString();
  let clock = 0;
  const tick = () => at(++clock);
  const state = {
    calls: [],
    violations: [],
    conflicts: 0,
    limit: null,
    alertsOff: false,
    destinations: [],
    lastCreated: null,
    watchlists: new Map([
      [
        "wl_1",
        {
          id: "wl_1",
          name: "Crypto",
          symbols: [
            { symbol: "BTC", category: "Crypto", venue: { source: "hyperliquid", ticker: "BTC" } },
            { symbol: "SOLUSD", category: "Crypto" },
          ],
          createdAt: at(0),
          updatedAt: at(0),
        },
      ],
    ]),
    rules: new Map(),
  };
  const view = (rule, extra = {}) => ({
    rule,
    statusReason: null,
    statusMarket: null,
    origin: null,
    liveState: rule.status === "active" ? "arming" : null,
    armedAt: null,
    createdAt: at(0),
    updatedAt: at(0),
    ...extra,
  });

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
    // The chart tools ask the app for a chart session first; this stand-in has none (404, the app's answer while they are off).
    if (url.pathname.startsWith("/api/chart-sessions")) return send(404, { message: "Not found" });
    const call = { method: req.method, path: url.pathname, auth: req.headers.authorization, body };
    state.calls.push(call);
    if (!ALLOWED.some(([method, re]) => method === req.method && re.test(url.pathname))) {
      state.violations.push(`${req.method} ${url.pathname}`);
      return send(404, { message: "Not found" });
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: "Unauthorized" });
    const limit = (permission, detail) => send(403, { message: `Not enough permissions (${permission}): ${detail}`, details: { permission } });

    const path = url.pathname;
    if (path === "/api/quant/watchlists" && req.method === "GET") return send(200, { watchlists: [...state.watchlists.values()] });
    if (path === "/api/quant/watchlists" && req.method === "POST") {
      if (typeof body?.name !== "string" || body.name.length < 1 || body.name.length > 200) return send(400, { message: "name" });
      if (body.symbols !== undefined && (!Array.isArray(body.symbols) || body.symbols.some(rowProblem))) return send(400, { message: "symbols" });
      if (state.limit === "maxWatchlists") return limit("maxWatchlists", "your plan allows up to 3 watchlists");
      const id = `wl_${state.watchlists.size + 1}`;
      state.watchlists.set(id, { id, name: body.name, symbols: body.symbols ?? [], createdAt: tick(), updatedAt: at(clock) });
      return send(200, { created: true, id });
    }
    const wl = /^\/api\/quant\/watchlists\/([^/]+)$/.exec(path);
    if (wl) {
      const list = state.watchlists.get(decodeURIComponent(wl[1]));
      if (!list) return send(404, { message: "No watchlist found for the ID provided" });
      if (req.method === "GET") return send(200, list);
      call.listUpdatedAt = list.updatedAt;
      if (body?.kind !== "symbols" || !Array.isArray(body.symbols) || body.symbols.some(rowProblem)) return send(400, { message: "symbols is required when kind is symbols" });
      if (body.ifUpdatedAt !== undefined && !ISO_OFFSET.test(body.ifUpdatedAt)) return send(400, { message: "ifUpdatedAt" });
      if (state.conflicts > 0) {
        // Another device saves first: the list moves on and this save is refused.
        state.conflicts--;
        list.symbols = [...list.symbols, { symbol: "OTHERDEVICE", category: "Stocks" }].filter((r, i, all) => all.findIndex((x) => x.symbol === r.symbol) === i);
        list.updatedAt = tick();
      }
      if (body.ifUpdatedAt !== undefined && body.ifUpdatedAt !== list.updatedAt) return send(409, { message: "stale", details: { updatedAt: list.updatedAt } });
      list.symbols = body.symbols;
      list.updatedAt = tick();
      return send(200, { ok: true, updatedAt: list.updatedAt });
    }
    if (path === "/api/quant/workspaces") {
      return send(200, { workspaces: [{ id: "ws_1", name: "Morning scan", updatedAt: at(5), shared: false, shareIncludeChart: false, shareIncludeWidgets: false }] });
    }

    // Alerts: 404 while the app's alerts are off for the account.
    if (state.alertsOff) return send(404, { message: "Not found" });
    if (path === "/api/alert-destinations/in-app") return send(200, { destinations: state.destinations });
    if (path === "/api/alert-rules" && req.method === "GET") {
      const rules = [...state.rules.values()].map((r) => view(r));
      return send(200, { rules, usage: { price: { active: rules.filter((v) => v.rule.type === "price" && v.rule.status === "active").length, limit: 5 }, agent: { active: 1, limit: null } } });
    }
    if (path === "/api/alert-rules" && req.method === "POST") {
      const problem = ruleProblem(body?.rule);
      if (problem) return send(400, { message: "This alert is not valid", details: { issues: [problem] } });
      if (body.status !== undefined && !["active", "paused"].includes(body.status)) return send(400, { message: "status" });
      if (state.limit === "maxPriceAlerts" && body.rule.type === "price") return limit("maxPriceAlerts", "your plan allows 5 Price Alerts on at once");
      const rule = { ...body.rule, id: `alr_${state.rules.size + 1}`, version: 1, status: body.status ?? "active", createdAt: Date.now() };
      state.rules.set(rule.id, rule);
      state.lastCreated = rule;
      return send(201, { rule: view(rule) });
    }
    if (path === "/api/alert-rules/preview") {
      const draft = body?.draft;
      const keys = Object.keys(body ?? {}).filter((k) => !["draft", "script", "native"].includes(k));
      if (keys.length || !draft || Object.keys(draft).some((k) => !["type", "name", "scope", "condition", "frequency", "tf"].includes(k))) {
        return send(400, { message: "This alert is not valid" });
      }
      if (draft.scope?.kind !== "market" || frequencyProblem(draft.frequency) || (draft.tf !== undefined && !Number.isInteger(draft.tf))) {
        return send(400, { message: "This alert is not valid" });
      }
      if (body.script && Object.keys(body.script).some((k) => !["userScriptId", "libraryId", "code", "title", "inputs"].includes(k))) return send(400, { message: "script" });
      const condition = body.script ? { ...draft.condition, ref: { script: { libraryId: body.script.libraryId, version: "f".repeat(64) }, inputs: {}, tf: draft.tf } } : draft.condition;
      return send(200, {
        rule: { type: draft.type, name: draft.name ?? (body.native ? "RSI 14 crosses above 70" : "Smart Money Concepts: Bullish BOS"), scope: draft.scope, condition, frequency: draft.frequency },
        defaultTemplate: "The alert fired on {{market}}",
        preview: { status: "ok", count: 12, perDay: 0.4, days: 30, noisy: false, onlyOnce: false, fromMs: 0, lastBarTime: 0, recentFires: [{ time: 0, price: 64000, message: "fired" }] },
      });
    }
    const toggle = /^\/api\/alert-rules\/([^/]+)\/(pause|resume)$/.exec(path);
    if (toggle) {
      const rule = state.rules.get(decodeURIComponent(toggle[1]));
      if (!rule) return send(404, { message: "Alert not found" });
      rule.status = toggle[2] === "pause" ? "paused" : "active";
      return send(200, { rule: view(rule) });
    }
    if (path === "/api/alert-events") {
      const delivery = { destinationId: "dst_app", kind: "inapp", label: null, status: "sent", attempts: 1, lastCode: null, latencyMs: 80, lastError: null, updatedAt: at(9) };
      return send(200, {
        events: [
          { id: "ev_1", ruleId: "alr_1", ruleName: "BTCUSDT crosses above 100000.5", market: "binance:BTCUSDT", eventTime: at(8), barTime: at(0), payload: { price: 64123.5 }, flags: [], bar: [0, 1, 2, 3, 64123.5, 9], deliveries: [delivery] },
          { id: "ev_2", ruleId: "alr_9", ruleName: "Apple above 190", market: "edgx:AAPL", eventTime: at(7), barTime: at(0), payload: { price: 190.12 }, flags: [], bar: [0, 1, 2, 3, 190.12, 9], deliveries: [] },
        ],
        nextCursor: null,
      });
    }
    return send(404, { message: "Not found" });
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

/** A node-http entry with the account tools on and the chart tools off, so the Claude address is as reviewed. */
async function startHttpEntry() {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), MCP_RESOURCE: `http://localhost:${port}/mcp`, LUXALGO_ACCOUNT_TOOLS: "on" };
  delete env.LUXALGO_CHART_TOOLS;
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

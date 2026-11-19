/*
  The member's open Vela chart, read and changed by their AI assistant (opt-in:
  LUXALGO_CHART_CONTROL_TOOLS=on or a Vercel preview): its market, timeframe,
  look and layout, a pro's markup found on its own candles, and drawings.

  1. The server under test: when it lists these tools, an anonymous read and an
     anonymous change meet the sign-in challenge (401 hosted, in-band on stdio).
  2. A node-http entry this suite starts with the tools on: the standard and the
     ChatGPT addresses list them, protected, with their annotations (removing
     drawings is the one marked destructive) and copy; anonymous calls are
     refused with 401; the Claude address lists none of them and its tool list
     is byte for byte the one under review. A second entry started as LuxAlgo's
     production deployment is, with no switch set: the standard address lists
     them, the ChatGPT address does not, and LUXALGO_CHART_CONTROL_TOOLS=off
     takes them off everywhere.
  3. A stdio entry signed in to a stand-in for the app's route (a local server
     that takes the bodies the app takes and refuses what it refuses): a read in
     words, a change sent in the app's own names with only what was asked, the
     answers for no open tab, a chart that could not do it, a plan limit, a
     timeframe no chart has and the app's switch being off, a markup with the
     prices the app gave (a crypto chart) and without any (a stock chart), a
     walkthrough of the parts the assistant explained, a change queued for a
     member whose Vela is not on screen, and drawings drawn and removed. Calls
     the tool can refuse itself never reach the app. The
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
    const reading = ["vela_read_chart", "vela_get_indicator_settings"];
    const changing = VELA_CHART.filter((n) => !reading.includes(n));
    check(
      "reading the chart and an indicator's settings is read-only; changing, marking up, drawing, removing, and adding, removing and tuning indicators are not, and all nine reach outside (the member's browser)",
      reading.every((n) => a(n).readOnlyHint === true) &&
        changing.length === 7 &&
        changing.every((n) => a(n).readOnlyHint === false) &&
        VELA_CHART.every((n) => a(n).openWorldHint === true),
      VELA_CHART.map((n) => `${n} ${JSON.stringify(a(n))}`).join("; "),
    );
    check(
      "only removing drawings and removing indicators are marked destructive",
      VELA_CHART.every((n) => a(n).destructiveHint === (n === "vela_remove_drawings" || n === "vela_remove_indicators")),
    );
    const addProps = tool("vela_add_indicator").inputSchema?.properties ?? {};
    check(
      "vela_add_indicator takes a Library slug or a saved script's id and nothing that could hold source code; it says it writes no indicator and returns no source",
      Object.keys(addProps).join() === "slot,library_slug,script_id" &&
        Object.keys(addProps).every((p) => !/code|source|script$|pine/i.test(p)) &&
        addProps.script_id?.maxLength === 64 &&
        /does not take Pine Script® and does not write an indicator/.test(tool("vela_add_indicator").description) &&
        /never returns source code/.test(tool("vela_add_indicator").description) &&
        /library_search/.test(tool("vela_add_indicator").description) &&
        /quant_search_user_scripts/.test(tool("vela_add_indicator").description),
      Object.keys(addProps).join(", "),
    );
    check(
      "vela_remove_indicators needs the ids a read gives, says never to make one up, and that it removes the member's own indicators too, never drawings or a saved script",
      (tool("vela_remove_indicators").inputSchema?.required ?? []).join() === "ids" &&
        typeof tool("vela_remove_indicators").inputSchema?.properties?.ids?.items?.pattern === "string" &&
        /never make one up/.test(tool("vela_remove_indicators").description) &&
        /Each indicator comes with the id vela_remove_indicators takes/.test(tool("vela_read_chart").description) &&
        /remove only what they asked for/.test(tool("vela_remove_indicators").description) &&
        /never touches drawings/.test(tool("vela_remove_indicators").description) &&
        /does not delete a saved script/.test(tool("vela_remove_indicators").description),
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
      "vela_draw_on_chart needs its drawings and vela_mark_up_chart its concepts; vela_read_chart takes nothing",
      (tool("vela_draw_on_chart").inputSchema?.required ?? []).join() === "drawings" &&
        (tool("vela_mark_up_chart").inputSchema?.required ?? []).join() === "concepts" &&
        props("vela_read_chart").length === 0,
    );
    const conceptProps = tool("vela_mark_up_chart").inputSchema?.properties?.concepts?.items?.properties ?? {};
    const drawingProps = tool("vela_draw_on_chart").inputSchema?.properties?.drawings?.items?.properties ?? {};
    check(
      "a markup names concepts and never takes a price to draw at; a concept and a drawing can each carry an explanation for the walkthrough",
      conceptProps.concept?.enum?.length === 13 &&
        ["fair_value_gaps", "liquidity", "market_structure", "order_blocks", "key_levels"].every((c) => conceptProps.concept.enum.includes(c)) &&
        !("price" in conceptProps) &&
        !("points" in conceptProps) &&
        conceptProps.explain?.maxLength === 280 &&
        drawingProps.explain?.maxLength === 280,
      Object.keys(conceptProps).join(", "),
    );
    check(
      "each says it is the member's own Vela, not the chart in the chat; reading says the tab must be open and visible",
      VELA_CHART.every((n) => /has open right now in Vela/.test(tool(n).description)) &&
        /open and visible/.test(tool("vela_read_chart").description) &&
        /chart_open/.test(tool("vela_read_chart").description) &&
        /chart_open and chart_command/.test(tool("vela_set_chart").description),
    );
    check(
      "each changing tool says a change is queued when the member's Vela is not on screen, and applied when they look at it again",
      changing.every((n) => /queued and applied the moment they look at Vela again/.test(tool(n).description)),
    );
    check(
      "reading and changing say they carry no prices; a markup says where it returns prices and where not; drawing says never to draw at guessed prices",
      /no prices/.test(tool("vela_read_chart").description) &&
        /no prices/.test(tool("vela_set_chart").description) &&
        /with exact prices for a crypto chart fed by an exchange/.test(tool("vela_mark_up_chart").description) &&
        /without prices for any other market/.test(tool("vela_mark_up_chart").description) &&
        /never pass prices you made up/.test(tool("vela_mark_up_chart").description) &&
        /never at guessed ones/.test(tool("vela_draw_on_chart").description),
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

  // As LuxAlgo's production deployment runs: no switch set.
  const names = (list) => (list?.tools ?? []).map((t) => t.name);
  const listed = async (env) => {
    const hosted = await startHttpEntry(env);
    try {
      const lists = {
        standard: await rpc({ url: hosted.url }, "tools/list", {}),
        chatgpt: await rpc({ url: `${hosted.url}/openai` }, "tools/list", {}),
        claude: await rpc({ url: hosted.url, host: `claude.${new URL(hosted.url).host}` }, "tools/list", {}),
      };
      return {
        standard: names(lists.standard).filter((n) => VELA_CHART.includes(n)).length,
        chatgpt: names(lists.chatgpt).filter((n) => VELA_CHART.includes(n)).length,
        claude: names(lists.claude).filter((n) => VELA_CHART.includes(n)).length,
        claudeDigest: createHash("sha256").update(JSON.stringify(lists.claude?.tools ?? [])).digest("hex"),
      };
    } finally {
      hosted.stop();
    }
  };
  const production = await listed({ VERCEL_ENV: "production", LUXALGO_CHART_CONTROL_TOOLS: undefined });
  check(
    "in production with no switch set, the standard address lists all of them, the ChatGPT address none, and the Claude address stays as reviewed",
    production.standard === VELA_CHART.length && production.chatgpt === 0 && production.claude === 0 && production.claudeDigest === CLAUDE_TOOLS_SHA256,
    JSON.stringify({ ...production, claudeDigest: production.claudeDigest.slice(0, 12) }),
  );
  const off = await listed({ VERCEL_ENV: "production", LUXALGO_CHART_CONTROL_TOOLS: "off" });
  check("LUXALGO_CHART_CONTROL_TOOLS=off takes them off every address in production", off.standard === 0 && off.chatgpt === 0 && off.claude === 0, JSON.stringify({ standard: off.standard, chatgpt: off.chatgpt }));
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
        new RegExp(`Chart 0 \\(the one the member is working on\\): BINANCE:BTCUSDT, 1h, as candles\\. Indicators: ${VOLUME} and ${SMC}\\.`).test(read.text) &&
        read.data.charts?.[0]?.indicator_list?.[0]?.id === "i_0a81kq20f3m9zx" &&
        read.data.charts?.[0]?.indicator_list?.[0]?.builtin === true &&
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
    const noTab = await call("vela_read_chart");
    check(
      "with no visible Vela tab, a read says there is nothing to read and asks the member to open Vela, keep it visible and ask again in a minute",
      !noTab.isError && noTab.data.status === "no_open_chart" && /nothing to read/.test(noTab.text) && /vela\.luxalgo\.com\/chart/.test(noTab.text) && /visible/.test(noTab.text) && /in a minute/.test(noTab.text),
      noTab.text.slice(0, 160),
    );
    state.mode = "queued";
    const queued = await call(...CHANGE);
    check(
      "a change asked for while the member's Vela is not on screen is said to be queued, not done: applied when they look at Vela again, with where to open it",
      !queued.isError &&
        queued.data.status === "queued" &&
        /^Queued, not applied yet/.test(queued.text) &&
        /the moment they look at their Vela tab/.test(queued.text) &&
        /vela\.luxalgo\.com\/chart/.test(queued.text) &&
        !/^Done/.test(queued.text),
      queued.text.slice(0, 160),
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

    const marked = await call("vela_mark_up_chart", {
      concepts: [
        { concept: "dealing_range", ote: true, explain: "  Where price is cheap or dear inside the last swing.  " },
        { concept: "fair_value_gaps", count: 2 },
      ],
    });
    check(
      "vela_mark_up_chart names concepts only, and an explanation reaches the app as that part's walkthrough text",
      JSON.stringify(sent()) ===
        '{"op":"markup","markup":{"concepts":[{"concept":"dealing_range","ote":true,"teach":"Where price is cheap or dear inside the last swing."},{"concept":"fair_value_gaps","count":2}]}}',
      JSON.stringify(sent()),
    );
    check(
      "on a crypto chart fed by an exchange it says what was found with the prices the app gave, each once, and that the member is being walked through it",
      !marked.isError &&
        /^Marked up, 9 drawings on the member's chart:/.test(marked.text) &&
        /- the dealing range 61,200 – 66,800 \(group "dealing-range-a1b2"\): EQ \(64,000\) \(2026-11-18 14:00, equilibrium\)\./.test(marked.text) &&
        /- 2 fair value gaps \(group "fair-value-gaps-c3d4"\): Bullish FVG at 62,100 and 62,450 \(2026-11-18 09:00, active\); Bearish FVG at 65,900 and 66,300 \(2026-11-17 21:00, mitigated\)\./.test(marked.text) &&
        !/Prices are not returned/.test(marked.text) &&
        /walked through that part on the chart/.test(marked.text) &&
        marked.data.marked?.priced === true &&
        marked.data.walkthrough === 1,
      marked.text.slice(0, 260),
    );
    state.market = "stock";
    const stock = await call("vela_mark_up_chart", { concepts: [{ concept: "dealing_range" }, { concept: "fair_value_gaps" }] });
    check(
      "on any other market it names what was found without a single price, and says the levels are on the member's chart",
      !stock.isError &&
        /- the dealing range \(group "dealing-range-a1b2"\): EQ \(2026-11-18 14:00, equilibrium\)\./.test(stock.text) &&
        /Bullish FVG \(2026-11-18 09:00, active\)/.test(stock.text) &&
        /Prices are not returned for this market/.test(stock.text) &&
        /never state or estimate a price/.test(stock.text) &&
        stock.data.marked?.priced === false &&
        ["61,200", "66,800", "64,000", "62,100", "62,450", "65,900", "66,300"].every((price) => !stock.text.includes(price) && !JSON.stringify(stock.data).includes(price)),
      stock.text.slice(0, 260),
    );
    state.market = "crypto";

    const drawn = await call("vela_draw_on_chart", {
      slot: 0,
      title: "Range plan",
      drawings: [
        { type: "level", points: [{ time: "2026-11-01 00:00", price: 70000 }], label: "Resistance", tone: "bearish", explain: "The level the bounce has to clear." },
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
        sent()?.drawing?.drawings?.[0]?.teach === "The level the bounce has to clear." &&
        !("explain" in (sent()?.drawing?.drawings?.[0] ?? {})) &&
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

    const library = await call("vela_add_indicator", { library_slug: "smart-money-concepts" });
    check(
      "vela_add_indicator sends a Library indicator's slug and says the name it goes by on the chart",
      !library.isError &&
        JSON.stringify(sent()) === '{"op":"add_indicator","indicator":{"library":"smart-money-concepts"}}' &&
        /^Added Smart Money Concepts \[LuxAlgo\] from the LuxAlgo Library to the member's chart\. Its id there is i_1c07tz50b2w8ne, which vela_remove_indicators takes\./.test(library.text) &&
        new RegExp(`Indicators: ${VOLUME} and ${SMC}`).test(library.text) &&
        library.data.indicator_added?.id === "i_1c07tz50b2w8ne" &&
        library.data.indicator_added?.from === "library" &&
        library.data.indicator_added?.name === "Smart Money Concepts [LuxAlgo]",
      library.text.slice(0, 200),
    );
    const saved = await call("vela_add_indicator", { slot: 1, script_id: "scr_my_strategy" });
    check(
      "it sends one of the member's saved scripts by its id, to the chart asked for, and says when it is a strategy",
      !saved.isError &&
        JSON.stringify(sent()) === '{"op":"add_indicator","indicator":{"slot":1,"script":"scr_my_strategy"}}' &&
        /^Added My Breakout from the member's saved scripts to the member's chart, a strategy: its backtest runs on the chart\./.test(saved.text) &&
        saved.data.indicator_added?.kind === "strategy",
      saved.text.slice(0, 200),
    );
    const callsBefore = state.calls.length;
    const both = await call("vela_add_indicator", { library_slug: "smart-money-concepts", script_id: "scr_my_strategy" });
    const neither = await call("vela_add_indicator", {});
    check(
      "asked for both, or for neither, it adds nothing and never calls the app",
      both.isError && neither.isError && /one of the two/.test(both.text) && /one of the two/.test(neither.text) && state.calls.length === callsBefore,
      both.text,
    );
    const noCode = await call("vela_add_indicator", { library_slug: "smart-money-concepts", code: 'indicator("x")' }).catch((error) => ({ isError: true, text: String(error?.message ?? error) }));
    check(
      "source code handed to it never reaches the app",
      state.calls.slice(callsBefore).every((c) => !JSON.stringify(c.body).includes('indicator(\\"x')),
      noCode.text.slice(0, 120),
    );
    const paid = await call("vela_add_indicator", { library_slug: "paid-toolkit" });
    check(
      "a paid Library indicator the member's plan does not include is not added, and the result says so in the app's words",
      paid.isError && paid.data.status === "failed" && /The chart could not do that: "paid-toolkit" is a paid LuxAlgo Library indicator the member's plan does not include/.test(paid.text),
      paid.text.slice(0, 200),
    );
    const unknown = await call("vela_add_indicator", { library_slug: "no-such-indicator" });
    check("a slug the Library does not have changes nothing and says to search for the right one", unknown.isError && /^Nothing changed: No Library indicator has the slug "no-such-indicator"/.test(unknown.text), unknown.text.slice(0, 160));

    state.withSaved = true;
    const withSaved = await call("vela_read_chart");
    state.withSaved = false;
    check(
      "a read gives each indicator the id a removal takes, and the member's own saved script its script id, which Quant changes it by",
      !withSaved.isError &&
        /My RSI \(id i_0k3v9qa1x7m2pd, the member's saved script scr_my_rsi\)/.test(withSaved.text) &&
        withSaved.data.charts?.[0]?.indicator_list?.[2]?.script_id === "scr_my_rsi" &&
        withSaved.data.charts?.[0]?.indicator_list?.[1]?.script_id === undefined,
      withSaved.text.slice(0, 260),
    );
    state.noIds = true;
    const older = await call("vela_read_chart");
    state.noIds = false;
    check(
      "an app that gives no ids yet is still read: the indicators by name",
      !older.isError && /Indicators: Volume and Smart Money Concepts \[LuxAlgo\]\./.test(older.text) && older.data.charts?.[0]?.indicator_list === undefined,
      older.text.slice(0, 160),
    );

    const tookOff = await call("vela_remove_indicators", { ids: ["i_1c07tz50b2w8ne", "i_0zz91ab0c3d4ef"] });
    check(
      "vela_remove_indicators sends the ids, says what came off by name and which id named nothing, and what the chart shows now",
      !tookOff.isError &&
        JSON.stringify(sent()) === '{"op":"remove_indicator","indicators":{"ids":["i_1c07tz50b2w8ne","i_0zz91ab0c3d4ef"]}}' &&
        /^Removed Smart Money Concepts \[LuxAlgo\] from the member's chart\. No indicator on the chart has the id i_0zz91ab0c3d4ef any more\./.test(tookOff.text) &&
        new RegExp(`Indicators: ${VOLUME}\\.`).test(tookOff.text) &&
        tookOff.data.indicators_removed?.names?.join() === "Smart Money Concepts [LuxAlgo]" &&
        tookOff.data.indicators_removed?.not_on_chart?.join() === "i_0zz91ab0c3d4ef",
      tookOff.text.slice(0, 220),
    );
    const callsSoFar = state.calls.length;
    const byName = await call("vela_remove_indicators", { ids: ["Smart Money Concepts [LuxAlgo]"] }).catch((error) => ({ isError: true, text: String(error?.message ?? error) }));
    check("a name, or anything else that is not an id from a read, is refused here and never reaches the app", byName.isError && state.calls.length === callsSoFar, byName.text.slice(0, 140));
    const settings = await call("vela_get_indicator_settings", { id: "i_0k3v9qa1x7m2pd" });
    check(
      "vela_get_indicator_settings lists an indicator's settings as its dialog shows them: name, kind, value and what each may hold",
      !settings.isError &&
        JSON.stringify(sent()) === '{"op":"indicator_settings","settings":{"id":"i_0k3v9qa1x7m2pd"}}' &&
        /^My RSI has 3 settings \(vela_set_indicator_settings takes these names\):\n- Length \(int\) = 14 \[min 1, max 500\]\n- Source \(source\) = "close" \[one of "open", "high", "low", "close"\]\n- Show labels \(bool\) = true/.test(settings.text) &&
        settings.data.indicator_settings?.settings?.[0]?.max === 500,
      settings.text.slice(0, 240),
    );
    const tuned = await call("vela_set_indicator_settings", { id: "i_0k3v9qa1x7m2pd", settings: [{ name: "Length", value: 21 }, { name: "Show labels", value: false }] });
    check(
      "vela_set_indicator_settings sends the settings by name and says each one changed, from what to what",
      !tuned.isError &&
        JSON.stringify(sent()) === '{"op":"set_indicator_settings","settings":{"id":"i_0k3v9qa1x7m2pd","inputs":[{"name":"Length","value":21},{"name":"Show labels","value":false}]}}' &&
        /^Changed My RSI on the member's chart: Length from 14 to 21 and Show labels from true to false\./.test(tuned.text) &&
        tuned.data.settings_changed?.applied?.length === 2,
      tuned.text.slice(0, 200),
    );
    const tooLong = await call("vela_set_indicator_settings", { id: "i_0k3v9qa1x7m2pd", settings: [{ name: "Length", value: 5000 }] });
    check(
      "a value the indicator does not allow changes nothing, and the result says why in the app's words",
      tooLong.isError && tooLong.data.status === "failed" && /The chart could not do that: Nothing was changed on My RSI\. "Length" must be at most 500\./.test(tooLong.text),
      tooLong.text.slice(0, 200),
    );
    const described = Object.fromEntries((await member.listTools()).tools.map((t) => [t.name, t.description]));
    check(
      "the settings tools say to read the settings first, that Vela checks every value, and that the script itself is not edited",
      /read the settings first rather than guessing names/.test(described.vela_set_indicator_settings) &&
        /checks every value against what the indicator declares/.test(described.vela_set_indicator_settings) &&
        /the script itself is not edited/.test(described.vela_set_indicator_settings) &&
        /no source code/.test(described.vela_get_indicator_settings),
    );

    state.mode = "queued";
    const noSettings = await call("vela_get_indicator_settings", { id: "i_0k3v9qa1x7m2pd" });
    const tuneLater = await call("vela_set_indicator_settings", { id: "i_0k3v9qa1x7m2pd", settings: [{ name: "Length", value: 21 }] });
    check(
      "with the member's Vela not on screen, reading settings says there is no open chart and a settings change is queued",
      noSettings.data.status === "no_open_chart" && tuneLater.data.status === "queued",
      `${noSettings.data.status} / ${tuneLater.data.status}`,
    );
    const later = await call("vela_add_indicator", { library_slug: "smart-money-concepts" });
    check("an indicator asked for while the member's Vela is not on screen is queued, and the result says so", !later.isError && later.data.status === "queued" && /^Queued, not applied yet/.test(later.text), later.text.slice(0, 80));
    state.mode = "ok";

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
const DRAWING_KEYS = ["type", "points", "time", "label", "text", "tone", "dash", "extend", "end_time", "arrow", "stop", "target", "teach"];
const CONCEPT_KEYS = [
  "concept", "teach", "count", "direction", "mitigation", "include_mitigated", "inversions", "include_swept", "strength",
  "breakers", "ote", "quarters", "high", "low", "leg", "extensions", "gap_kind", "only", "windows", "days", "levels",
];
const LAYOUT = /^(1|2h|2v|4|8|g[1-4]x[1-4]|big-(left|top)-[23]|big-(right|bottom)-2)$/;
/** The app's timeframes: whole minutes, hours, days, weeks or months. */
const TIMEFRAME = /^(\d+)?\s*(m|h|d|w|M)?$/i;

/** Why the app would refuse this body's shape (its contract), or null. */
function bodyProblem(body) {
  if (!body || typeof body !== "object" || !["read", "set", "markup", "draw", "remove", "add_indicator", "remove_indicator", "indicator_settings", "set_indicator_settings"].includes(body.op)) return "op";
  if (Object.keys(body).some((key) => !["op", "state", "markup", "drawing", "removal", "indicator", "indicators", "settings"].includes(key))) return "unknown field";
  if (body.op === "indicator_settings" || body.op === "set_indicator_settings") {
    const settings = body.settings;
    const allowed = body.op === "indicator_settings" ? ["slot", "id"] : ["slot", "id", "inputs"];
    if (!settings || !/^i_[a-z0-9]{6,16}$/.test(settings.id ?? "") || Object.keys(settings).some((key) => !allowed.includes(key))) return "settings";
    if (body.op === "set_indicator_settings" && (!Array.isArray(settings.inputs) || settings.inputs.length < 1 || settings.inputs.some((input) => Object.keys(input).sort().join() !== "name,value"))) return "settings.inputs";
  }
  if (body.op === "add_indicator") {
    const indicator = body.indicator;
    if (!indicator || Object.keys(indicator).some((key) => !["slot", "library", "script"].includes(key))) return "indicator";
    if ((indicator.library === undefined) === (indicator.script === undefined)) return "indicator names one thing";
  }
  if (body.op === "remove_indicator") {
    const indicators = body.indicators;
    if (!indicators || !Array.isArray(indicators.ids) || indicators.ids.length < 1 || Object.keys(indicators).some((key) => !["slot", "ids"].includes(key))) return "indicators";
    if (indicators.ids.some((id) => !/^i_[a-z0-9]{6,16}$/.test(id))) return "indicators.ids";
  }
  if (body.op === "markup") {
    const markup = body.markup;
    if (!markup || !Array.isArray(markup.concepts) || markup.concepts.length < 1 || markup.concepts.length > 6) return "markup";
    if (Object.keys(markup).some((key) => !["slot", "concepts", "replace"].includes(key))) return "markup fields";
    if (markup.concepts.some((c) => Object.keys(c).some((key) => !CONCEPT_KEYS.includes(key)))) return "markup.concepts";
  }
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

/** The id the app gives each indicator in its answers (its own making, never the chart's). */
const INDICATOR_IDS = { Volume: "i_0a81kq20f3m9zx", "Smart Money Concepts [LuxAlgo]": "i_1c07tz50b2w8ne", "My RSI": "i_0k3v9qa1x7m2pd" };
const VOLUME = "Volume \\(id i_0a81kq20f3m9zx\\)";
const SMC = "Smart Money Concepts \\[LuxAlgo\\] \\(id i_1c07tz50b2w8ne\\)";

/** One chart as the app reports it; `noIds` is an app from before indicators had ids. */
const chartNow = ({ noIds = false, ...overrides } = {}) => {
  const chart = {
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
  };
  if (noIds) return chart;
  return {
    ...chart,
    indicatorList: chart.indicators.map((name) => ({
      id: INDICATOR_IDS[name] ?? "i_0000000unknown",
      name,
      ...(name === "Volume" ? { builtin: true } : {}),
      // Only the member's own saved script comes with its script id.
      ...(name === "My RSI" ? { scriptId: "scr_my_rsi" } : {}),
    })),
  };
};

async function startStandIn() {
  const state = { calls: [], violations: [], mode: "ok", market: "crypto" };
  /** What the app answers a markup with: priced for a crypto chart fed by an exchange, the same things unpriced for any other. */
  const found = (priced, explained) => ({
    slot: 0,
    priced,
    concepts: [
      {
        concept: "dealing-range",
        group: "dealing-range-a1b2",
        summary: priced ? "the dealing range 61,200 – 66,800" : "the dealing range",
        items: [{ label: priced ? "EQ (64,000)" : "EQ", ...(priced ? { prices: ["64,000"] } : {}), time: "2026-11-18 14:00", state: "equilibrium" }],
      },
      {
        concept: "fvg",
        group: "fair-value-gaps-c3d4",
        summary: "2 fair value gaps",
        items: [
          { label: "Bullish FVG", ...(priced ? { prices: ["62,100", "62,450"] } : {}), time: "2026-11-18 09:00", state: "active" },
          { label: "Bearish FVG", ...(priced ? { prices: ["65,900", "66,300"] } : {}), time: "2026-11-17 21:00", state: "mitigated" },
        ],
      },
    ],
    drawings: 9,
    explained,
  });
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
    // No Vela tab of the member on screen: a change waits for them, a read has nothing to read.
    if (state.mode === "queued") return send(200, { status: body.op === "read" || body.op === "indicator_settings" ? "no_open_chart" : "queued" });
    if (state.mode === "failed") {
      return send(200, { status: "failed", error: '"TVC:GOLD" is not a market Vela serves, so nothing was changed. Use the bare ticker, or a venue prefix Vela reads.', state: shows() });
    }
    if (body.op === "read") {
      const first = state.noIds ? { noIds: true } : state.withSaved ? { indicators: ["Volume", "Smart Money Concepts [LuxAlgo]", "My RSI"] } : {};
      return send(200, { status: "ok", state: shows(first) });
    }
    if (body.op === "set") {
      const first = body.state.charts?.find((chart) => (chart.slot ?? 0) === 0) ?? {};
      const symbols = new Set((body.state.charts ?? []).map((chart) => chart.symbol).filter(Boolean));
      return send(200, {
        status: "ok",
        state: shows({ ...(first.symbol ? { symbol: first.symbol } : {}), ...(first.timeframe ? { timeframe: first.timeframe } : {}) }),
        ...(body.state.charts?.length > 1 && symbols.size >= 1 ? { releasedSync: ["symbol"] } : {}),
      });
    }
    if (body.op === "markup") {
      const explained = body.markup.concepts.filter((c) => c.teach).length;
      const { explained: _explained, ...marked } = found(state.market === "crypto", explained);
      return send(200, { status: "ok", state: shows({ quantDrawings: 9 }), marked, ...(explained ? { walkthrough: explained } : {}) });
    }
    if (body.op === "indicator_settings") {
      return send(200, {
        status: "ok",
        state: shows(),
        indicatorSettings: {
          slot: 0,
          id: body.settings.id,
          name: "My RSI",
          settings: [
            { name: "Length", type: "int", value: 14, min: 1, max: 500 },
            { name: "Source", type: "source", value: "close", options: ["open", "high", "low", "close"] },
            { name: "Show labels", type: "bool", value: true },
          ],
        },
      });
    }
    if (body.op === "set_indicator_settings") {
      const now = { Length: 14, "Show labels": true };
      const tooLong = body.settings.inputs.find((input) => input.name === "Length" && input.value > 500);
      if (tooLong) return send(200, { status: "failed", error: 'Nothing was changed on My RSI. "Length" must be at most 500.', state: shows() });
      return send(200, {
        status: "ok",
        state: shows(),
        indicatorSettingsSet: { slot: 0, id: body.settings.id, name: "My RSI", applied: body.settings.inputs.map((input) => ({ name: input.name, from: now[input.name], to: input.value })) },
      });
    }
    if (body.op === "add_indicator") {
      const { slot = 0, library, script } = body.indicator;
      if (library === "no-such-indicator") return send(400, { message: 'No Library indicator has the slug "no-such-indicator". Search the Library for the right one.' });
      if (library === "paid-toolkit") {
        return send(200, { status: "failed", error: '"paid-toolkit" is a paid LuxAlgo Library indicator the member\'s plan does not include, so it was not added.' });
      }
      const indicatorAdded = library
        ? { slot, id: "i_1c07tz50b2w8ne", name: "Smart Money Concepts [LuxAlgo]", from: "library", kind: "indicator" }
        : { slot, id: "i_2b9mx4c0q7t1ya", name: "My Breakout", from: "saved", kind: script === "scr_my_strategy" ? "strategy" : "indicator" };
      return send(200, { status: "ok", state: shows(), indicatorAdded });
    }
    if (body.op === "remove_indicator") {
      const on = chartNow().indicatorList;
      const names = on.filter((row) => body.indicators.ids.includes(row.id)).map((row) => row.name);
      const notOnChart = body.indicators.ids.filter((id) => !on.some((row) => row.id === id));
      if (names.length === 0) return send(200, { status: "failed", error: "None of those ids is an indicator on this chart now, so nothing was removed. Read the chart again for the ids of what is on it.", state: shows() });
      return send(200, {
        status: "ok",
        state: shows({ indicators: on.map((row) => row.name).filter((name) => !names.includes(name)) }),
        indicatorsRemoved: { slot: body.indicators.slot ?? 0, names, ...(notOnChart.length ? { notOnChart } : {}) },
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

/**
 * A node-http entry with every opt-in tool on: the Claude address stays as reviewed with all of them.
 * `overrides` sets (or, with undefined, clears) variables on top, to start it as another deployment would run.
 */
async function startHttpEntry(overrides = {}) {
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
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
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

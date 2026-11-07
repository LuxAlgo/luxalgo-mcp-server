/*
  The Claude address (claude.mcp.luxalgo.com) is frozen while Anthropic reviews it:
  every tool definition and every result there stays byte for byte what it was. The
  ChatGPT address (/mcp/openai) and the standard one carry Vela chart links
  (`chart_url`); the Claude address does not, until the review is done.

  Runs over HTTP in both modes. With --http it uses that server (the Claude host is
  reached the way the discovery suite reaches it); over stdio it starts the built
  node-http entry on a free local port for the duration of the suite.

  If the Claude-address tool list changes on purpose (after the review, with the
  team's go-ahead), update CLAUDE_TOOLS_SHA256 in the same pull request and say why.
*/
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";

/** sha256 of JSON.stringify(tools/list `tools`) on the Claude address, as Anthropic is reviewing it (2.1.0). */
export const CLAUDE_TOOLS_SHA256 = "f2233dd025f31f7187f8d85f09f0cf240855182511781ef643bd4bba57996907";

const CHART_ORIGIN = process.env.LUXALGO_CHART_ORIGIN ?? "https://vela.luxalgo.com";

/** Result shapes on the Claude address today, in wire order. */
const FROZEN_KEYS = {
  sourceComplete: ["slug", "name", "available", "complete", "source"],
  indicator: ["slug", "name", "author", "family", "body_markdown", "image_url", "date_displayed", "url", "concepts", "code"],
  searchHit: ["kind", "slug", "name", "family", "description", "url"],
  listItem: ["slug", "name", "family", "description", "image_url", "date_displayed", "url"],
  concept: ["slug", "name", "family", "cluster", "aliases", "is_fringe", "url", "md_url", "content_markdown"],
  edgeSymbol: ["symbol", "assetClass", "adapter", "tf", "lastBar", "sessions"],
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** Starts dist/entries/node-http.js on a free port; resolves once it listens. */
async function startHttpEntry() {
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/entries/node-http.js"], {
    // The suite asserts anonymous behaviour only; the HTTP entry has no login store to read.
    env: { ...process.env, PORT: String(port), MCP_RESOURCE: `http://localhost:${port}/mcp` },
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

function addresses(base) {
  const standard = new URL(base);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(standard.hostname);
  const claude = new URL(base);
  claude.hostname = `claude.${claude.hostname}`;
  const openai = new URL(`${standard.pathname.replace(/\/+$/, "")}/openai`, standard);
  return {
    claude: local ? { url: standard, host: claude.host } : { url: claude },
    openai: { url: openai },
  };
}

/** One raw JSON-RPC call (2025-era framing, stateless), returning `result`. */
async function rpc({ url, host }, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(host ? { "x-forwarded-host": host } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  const body = JSON.parse(text.startsWith("{") ? text : (text.match(/^data: (.*)$/m)?.[1] ?? "{}"));
  return body.result;
}

async function call(address, name, args) {
  const result = await rpc(address, "tools/call", { name, arguments: args });
  const text = result?.content?.[0]?.text ?? "{}";
  return { isError: result?.isError === true, text, payload: JSON.parse(text) };
}

const sameKeys = (object, keys) => JSON.stringify(Object.keys(object ?? {})) === JSON.stringify(keys);
const keysOf = (object) => Object.keys(object ?? {}).join(",");

export async function run({ check, httpUrl }) {
  const server = httpUrl ? null : await startHttpEntry();
  try {
    const { claude, openai } = addresses(httpUrl ?? server.url);

    // ── the Claude address: unchanged ──────────────────────────────────────
    const listed = await rpc(claude, "tools/list", {});
    const digest = createHash("sha256").update(JSON.stringify(listed?.tools ?? [])).digest("hex");
    check(
      "the Claude address lists every tool exactly as Anthropic is reviewing it",
      digest === CLAUDE_TOOLS_SHA256,
      `${listed?.tools?.length} tools, sha256 ${digest.slice(0, 12)}…`,
    );

    const calls = {
      source: await call(claude, "library_get_source_code", { slug: "dynamic-order-blocks" }),
      indicator: await call(claude, "library_get_indicator", { slug: "dynamic-order-blocks" }),
      search: await call(claude, "library_search", { query: "order blocks", type: "indicators", limit: 5 }),
      list: await call(claude, "library_list_indicators", { text: "supertrend", page_size: 5 }),
      concept: await call(claude, "library_get_concept", { slug: "rsi" }),
      edge: await call(claude, "edge_report", { preset: "gap-fill", symbol: "BTCUSDT" }),
      edgeSymbols: await call(claude, "edge_symbols", {}),
    };
    const failed = Object.entries(calls).filter(([, c]) => c.isError).map(([name]) => name);
    check("every Claude-address call in this suite answers", failed.length === 0, failed.join(", ") || "7 calls");

    const { source, indicator, search, list, concept, edge, edgeSymbols } = calls;
    check(
      "on the Claude address, Library results keep today's shape with no chart links added",
      (source.payload.complete !== true || sameKeys(source.payload, FROZEN_KEYS.sourceComplete)) &&
        sameKeys(indicator.payload, FROZEN_KEYS.indicator) &&
        search.payload.results?.length > 0 &&
        search.payload.results.every((hit) => sameKeys(hit, FROZEN_KEYS.searchHit)) &&
        list.payload.indicators?.length > 0 &&
        list.payload.indicators.every((row) => sameKeys(row, FROZEN_KEYS.listItem)) &&
        sameKeys(concept.payload, FROZEN_KEYS.concept),
      `source: ${keysOf(source.payload)}; indicator: ${keysOf(indicator.payload)}; concept: ${keysOf(concept.payload)}`,
    );
    check(
      "on the Claude address, Edge Stats results carry no chart link",
      !edge.text.includes("chart_url") &&
        edgeSymbols.payload.symbols?.length > 0 &&
        edgeSymbols.payload.symbols.every((s) => sameKeys(s, FROZEN_KEYS.edgeSymbol)),
      `edge_report keys: ${keysOf(edge.payload)}`,
    );

    // ── the ChatGPT address: Vela links ────────────────────────────────────
    const openaiSource = await call(openai, "library_get_source_code", { slug: "dynamic-order-blocks" });
    // An intraday preset that applies to a round-the-clock market (gap presets are refused there).
    const openaiEdge = await call(openai, "edge_report", { preset: "orb", symbol: "BTCUSDT" });
    check(
      "on the ChatGPT address, an indicator's source comes with its Vela chart link",
      !openaiSource.isError && openaiSource.payload.chart_url?.startsWith(`${CHART_ORIGIN}/chart?pineScriptCodeId=`),
      openaiSource.payload.chart_url ? "chart_url present" : "no chart_url",
    );
    check(
      "on the ChatGPT address, an Edge Stats report links to its market on Vela",
      !openaiEdge.isError && openaiEdge.payload.chart_url === `${CHART_ORIGIN}/chart?symbol=binance:BTCUSDT&tf=15`,
      openaiEdge.payload.chart_url ?? "no chart_url",
    );
  } finally {
    server?.stop();
  }
}

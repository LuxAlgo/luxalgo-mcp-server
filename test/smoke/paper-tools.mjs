/*
  Paper Trading by LuxAlgo for the member's AI assistant (opt-in:
  LUXALGO_PAPER_TOOLS=on or a Vercel preview). Simulated money only; every
  change is proposed first and placed only with the proposal's confirmation
  token, after the member said yes.

  1. The server under test: when it lists these tools, an anonymous read and an
     anonymous placement meet the sign-in challenge (401 hosted, in-band on stdio).
  2. A node-http entry this suite starts with the tools on: the standard and the
     ChatGPT addresses list them, protected, with their annotations (placing is
     the one write, marked destructive and closed-world); anonymous calls are
     refused with 401; the Claude address lists none of them and its tool list
     is byte for byte the one under review.
  3. A stdio entry signed in to a stand-in for the app's paper routes (a local
     server that keeps proposals and their single-use tokens the way the app
     does): placing without a token, with a made-up one, with a changed order or
     a second time is refused and places nothing; a proposal places nothing; the
     proposal's place_with places it once. The stand-in records any call outside
     the app's MCP allowlist for these tools, and the suite fails if there is one.
*/
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { PAPER } from "./surface.mjs";
import { CLAUDE_TOOLS_SHA256 } from "./claude-surface.mjs";

const TOKEN = "stand-in-token";
const READ = ["paper_account", {}];
const PLACE = ["paper_place_order", { confirmation_token: "lxpaper_x", symbol: "BTCUSD", side: "buy", quantity: 1 }];

export async function run({ client, check, httpUrl }) {
  await underTest(client, check, httpUrl);
  await addresses(check);
  await signedIn(check);
}

// ── 1. the server under test ────────────────────────────────────────────────

async function underTest(client, check, httpUrl) {
  const { tools } = await client.listTools();
  if (!tools.some((t) => PAPER.includes(t.name))) {
    console.log("(paper tools are off on the server under test; set LUXALGO_PAPER_TOOLS=on to check them there too)");
    return;
  }
  for (const [name, args] of [READ, PLACE]) {
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
      `with the paper tools on, the standard address lists all ${PAPER.length} of them, each asking for a LuxAlgo sign-in`,
      PAPER.every((name) => {
        const tool = standardTools?.tools?.find((t) => t.name === name);
        return tool?.securitySchemes?.some((s) => s.type === "oauth2") && / Requires signing in with a LuxAlgo account \(OAuth\)\.$/.test(tool.description);
      }),
      `${names(standardTools).filter((n) => PAPER.includes(n)).length} of ${PAPER.length}`,
    );
    check("the ChatGPT address lists them too", PAPER.every((name) => names(openaiTools).includes(name)), names(openaiTools).filter((n) => PAPER.includes(n)).join(", "));
    const digest = createHash("sha256").update(JSON.stringify(claudeTools?.tools ?? [])).digest("hex");
    check(
      "the Claude address lists none of them and stays byte for byte the tool list under review",
      names(claudeTools).every((n) => !PAPER.includes(n)) && digest === CLAUDE_TOOLS_SHA256,
      `${claudeTools?.tools?.length} tools, sha256 ${digest.slice(0, 12)}…`,
    );

    const statuses = [];
    for (const [name, args] of [READ, PLACE]) {
      const response = await post(standard.url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      statuses.push(`${name} ${response.status}`);
    }
    check("on the standard address, an anonymous read and placement are refused with 401", statuses.every((s) => s.endsWith(" 401")), statuses.join("; "));

    const tool = (name) => standardTools?.tools?.find((t) => t.name === name) ?? {};
    const a = (name) => tool(name).annotations ?? {};
    const others = PAPER.filter((n) => n !== "paper_place_order");
    check(
      "placing is the one write: marked destructive and closed-world, so hosts ask the user first",
      a("paper_place_order").readOnlyHint === false && a("paper_place_order").destructiveHint === true && a("paper_place_order").openWorldHint === false,
      JSON.stringify(a("paper_place_order")),
    );
    check(
      "reading and proposing change nothing: read-only, closed-world",
      others.every((n) => a(n).readOnlyHint === true && a(n).destructiveHint === false && a(n).openWorldHint === false),
    );
    const required = (name) => (tool(name).inputSchema?.required ?? []).slice().sort().join();
    check(
      "paper_place_order needs the confirmation token and the order restated",
      required("paper_place_order") === "confirmation_token,symbol" &&
        ["side", "quantity"].every((p) => Object.keys(tool("paper_place_order").inputSchema?.properties ?? {}).includes(p)),
      required("paper_place_order"),
    );
    const copy = PAPER.map((n) => `${tool(n).title} ${tool(n).description}`).join(" ");
    check(
      "every description says it is LuxAlgo's paper simulator with simulated money, never real money",
      PAPER.every((n) => /Paper Trading by LuxAlgo/.test(tool(n).description) && /simulated money/.test(tool(n).description) && /never real money/.test(tool(n).description)),
    );
    check(
      "the proposing tools tell the model to show the order and wait for the member's explicit yes; placing says to call it only after that yes",
      ["paper_propose_order", "paper_close_position", "paper_cancel_order"].every((n) => /wait for their explicit yes/.test(tool(n).description)) &&
        /only after you showed the member that exact proposal and they said yes/.test(tool("paper_place_order").description),
    );
    const banned = [/QuantCharts/, /Quant AI/, /\bpane\b/i, /live trading is/i, /real money is/i, /guarantee/i];
    check("their copy has none of the retired terms or promises", banned.every((re) => !re.test(copy)), banned.filter((re) => re.test(copy)).join(", ") || "clean");
  } finally {
    entry.stop();
  }
}

// ── 3. signed in, against a stand-in for the app ─────────────────────────────

async function signedIn(check) {
  const app = await startStandIn();
  const dir = await mkdtemp(join(tmpdir(), "luxalgo-paper-tools-"));
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
  const member = new Client({ name: "paper-tools-smoke", version: "0" });
  await member.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: { ...getDefaultEnvironment(), LUXALGO_APP_ORIGIN: app.origin, LUXALGO_MCP_AUTH_FILE: authFile, LUXALGO_PAPER_TOOLS: "on" },
      stderr: "ignore",
    }),
  );
  const call = async (name, args = {}) => {
    const result = await member.callTool({ name, arguments: args });
    return { isError: result.isError === true, text: result.content?.[0]?.text ?? "", data: result.structuredContent ?? {} };
  };
  const { state } = app;
  try {
    const read = await call("paper_account");
    check(
      "paper_account reads the member's paper accounts and says the money is simulated",
      !read.isError && /simulated money/.test(read.text) && read.data.accounts?.[0]?.id === "paper_1" && read.data.open_orders?.[0]?.id === "ord_1",
      read.text.slice(0, 160),
    );

    const noToken = await call("paper_place_order", { symbol: "BTCUSD", side: "buy", quantity: 2 });
    const madeUp = await call("paper_place_order", { confirmation_token: "lxpaper_madeup", symbol: "BTCUSD", side: "buy", quantity: 2 });
    check(
      "placing without a confirmation token, or with a made-up one, is refused and places nothing",
      noToken.isError && madeUp.isError && /Nothing was placed/.test(madeUp.text) && state.placed.length === 0,
      `${noToken.text.slice(0, 80)} | ${madeUp.text.slice(0, 120)}`,
    );

    const proposed = await call("paper_propose_order", { symbol: "BTCUSD", side: "buy", quantity: 2 });
    const placeWith = proposed.data.place_with;
    check(
      "a proposal places nothing, describes the exact order with its estimated cost, and gives the arguments to place it once approved",
      !proposed.isError &&
        state.placed.length === 0 &&
        /^Proposed, not placed: Buy 2 units of BTCUSD at market on Paper Trading by LuxAlgo/.test(proposed.text) &&
        /estimated value \$200/.test(proposed.text) &&
        /ask for their yes/.test(proposed.text) &&
        placeWith?.confirmation_token?.startsWith("lxpaper_") &&
        placeWith.symbol === "BTCUSD" &&
        placeWith.side === "buy" &&
        placeWith.quantity === 2,
      proposed.text.slice(0, 200),
    );

    const changed = await call("paper_place_order", { ...placeWith, quantity: 20 });
    check(
      "a confirmation token with another order restated is refused and places nothing",
      changed.isError && /isn't the order/.test(changed.text) && state.placed.length === 0,
      changed.text.slice(0, 160),
    );

    const placed = await call("paper_place_order", placeWith);
    check(
      "with the member's yes, the proposal's place_with places that exact order once, on paper",
      !placed.isError && /^Placed and filled/.test(placed.text) && /Simulated money/.test(placed.text) && state.placed.length === 1 && state.placed[0].quantity === 2,
      placed.text.slice(0, 160),
    );

    const again = await call("paper_place_order", placeWith);
    check(
      "a confirmation token works once: a second placement is refused",
      again.isError && /already used/.test(again.text) && state.placed.length === 1,
      again.text.slice(0, 160),
    );

    const close = await call("paper_close_position", { symbol: "BTCUSD" });
    const cancel = await call("paper_cancel_order", { order_id: "ord_1" });
    check(
      "closing a position and cancelling an order are proposed first too, each with its own token",
      !close.isError &&
        !cancel.isError &&
        /^Proposed, not placed: Sell 1 unit of BTCUSD at market/.test(close.text) &&
        /^Proposed, not placed: Cancel the working paper order/.test(cancel.text) &&
        close.data.place_with?.confirmation_token !== cancel.data.place_with?.confirmation_token &&
        cancel.data.place_with?.side === undefined &&
        state.placed.length === 1,
      `${close.text.slice(0, 80)} | ${cancel.text.slice(0, 80)}`,
    );

    state.off = true;
    const off = await call("paper_account");
    check("while the app has it switched off (404), the tool says it is not open yet", off.isError && /not open on this LuxAlgo account yet/.test(off.text), off.text);
    state.off = false;

    check(
      "every call carried the member's token and stayed on the app's allowlist for these tools",
      state.violations.length === 0 && state.calls.every((c) => c.auth === `Bearer ${TOKEN}`),
      state.violations.join(", ") || `${state.calls.length} calls`,
    );
  } finally {
    await member.close();
    app.stop();
  }
}

// ── the stand-in app ─────────────────────────────────────────────────────────

/** The routes the app lets these tools reach with the member's token. */
const ALLOWED = [
  ["GET", /^\/api\/agents\/paper$/],
  ["POST", /^\/api\/agents\/paper\/proposals\/(order|close|cancel)$/],
  ["POST", /^\/api\/agents\/paper\/place$/],
];

async function startStandIn() {
  const state = { calls: [], violations: [], placed: [], proposals: new Map(), off: false, ids: 0 };
  const account = { id: "paper_1", name: "Paper Trading by LuxAlgo" };
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const proposal = (fields) => ({ simulated: true, account, warnings: [], expiresAt, status: "pending", ...fields });

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
    if (state.off) return send(404, { message: "Not available" });

    const propose = (p) => {
      const id = `prop_${++state.ids}`;
      const token = `lxpaper_${id}.${createHash("sha256").update(id).digest("hex")}`;
      state.proposals.set(token, { ...p, id, used: false });
      return send(200, { proposal: proposal({ id, ...p }), confirmationToken: token, expiresAt });
    };

    if (req.method === "GET") {
      return send(200, {
        simulated: true,
        accounts: [{ ...account, currency: "USD", startingBalance: 100000, balance: 100000, equity: 100010, openPnl: 10, todayPnl: 0, marginUsed: 100, marginFree: 99910, openPositions: 1, approximate: false }],
        positions: [{ accountId: "paper_1", symbol: "BTCUSD", direction: "long", quantity: 1, avgEntry: 90, mark: 100, openPnl: 10 }],
        openOrders: [{ id: "ord_1", accountId: "paper_1", symbol: "BTCUSD", side: "sell", type: "stop", quantity: 1, filledQuantity: 0, limitPrice: null, stopPrice: 80, reduceOnly: true, status: "open", placedAt: expiresAt }],
        recentFills: [],
      });
    }
    if (url.pathname.endsWith("/proposals/order")) {
      return propose({ action: "open", symbol: body.symbol, side: body.side, type: body.type, quantity: body.quantity, unit: "units", estimatedPrice: 100, estimatedValueUsd: body.quantity * 100, estimatedMarginUsd: body.quantity * 100 });
    }
    if (url.pathname.endsWith("/proposals/close")) {
      return propose({ action: "close", symbol: body.symbol, side: "sell", type: "market", quantity: 1, unit: "unit", estimatedPrice: 100, position: { direction: "long", quantity: 1, avgEntry: 90 } });
    }
    if (url.pathname.endsWith("/proposals/cancel")) {
      return propose({ action: "cancel", symbol: "BTCUSD", quantity: null, unit: null, estimatedPrice: null, cancels: [{ orderId: body.orderId, label: "Sell 1 BTCUSD stop at 80" }] });
    }
    // place: the token names one pending proposal of this member, once, for its exact order.
    const held = state.proposals.get(body.confirmationToken);
    if (!held) return send(404, { message: "That confirmation token isn't for one of your proposals. Nothing was placed.", details: { code: "not_found" } });
    if (held.used) return send(409, { message: "That confirmation token was already used, or the proposal expired. Nothing more was placed.", details: { code: "decided" } });
    if (body.symbol !== held.symbol || (held.action !== "cancel" && (body.side !== held.side || body.quantity !== held.quantity))) {
      return send(409, { message: "That isn't the order this confirmation token is for. Nothing was placed.", details: { code: "mismatch" } });
    }
    held.used = true;
    state.placed.push({ symbol: held.symbol, side: held.side, quantity: held.quantity });
    return send(200, {
      proposal: proposal({
        ...held,
        status: "executed",
        orders: [{ id: "o1", symbol: held.symbol, side: held.side, type: "market", status: "filled", quantity: held.quantity, filledQuantity: held.quantity, filledAvgPrice: 100 }],
      }),
    });
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
    LUXALGO_PAPER_TOOLS: "on",
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

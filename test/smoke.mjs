/*
  End-to-end smoke test: connects a real MCP client to the built server
  over stdio, lists tools, and calls all of them against the live LuxAlgo
  endpoints. Pass --http <url> to test a running streamable-HTTP server
  instead. Exits non-zero on any failure.

  One suite per tool domain under smoke/ (mirroring src/tools/), plus
  `surface` (tools/list, securitySchemes, serverInfo) and, over HTTP,
  `discovery` (OAuth discovery on the standard and the Claude host), and
  `claude-surface` (the Claude address stays frozen; over stdio it starts the
  node-http entry on a free port itself), and
  `answers-surfaces` (the Claude address keeps its reviewed answers). Run a subset with
  --only <suite>[,<suite>], e.g. `node test/smoke.mjs --only library,edge`.
*/
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { join } from "node:path";
import { tmpdir } from "node:os";

const httpUrl = process.argv.includes("--http")
  ? process.argv[process.argv.indexOf("--http") + 1]
  : null;

/**
 * The suite asserts ANONYMOUS behaviour (protected tools answer the sign-in
 * challenge), and its protected-tool calls include a write. The stdio server
 * under test must therefore never see this machine's login store — a
 * developer who ran `luxalgo-mcp login` would otherwise have the suite call
 * the real app as them and create a real journal note. Point the store at a
 * file that does not exist.
 */
const stdioEnv = {
  ...getDefaultEnvironment(),
  ...networkEnvironment(),
  LUXALGO_MCP_AUTH_FILE: join(tmpdir(), "luxalgo-mcp-smoke-no-login", "absent.json"),
};

/**
 * The SDK's default child environment drops everything but a few shell
 * variables, so behind an outbound proxy the stdio server could reach none of
 * the live endpoints. Pass the proxy and CA settings through, and nothing else.
 */
function networkEnvironment() {
  const names = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];
  const env = Object.fromEntries(names.filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
  // Node reads the proxy variables only with --use-env-proxy (or NODE_USE_ENV_PROXY=1).
  if (/--use-env-proxy\b/.test(process.env.NODE_OPTIONS ?? "")) env.NODE_USE_ENV_PROXY = "1";
  return env;
}

let failures = 0;
function check(label, condition, detail = "") {
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failures++;
  console.log(`${status}  ${label}${detail ? ` — ${detail}` : ""}`);
}

async function callJson(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? "";
  return { isError: result.isError === true, payload: JSON.parse(text) };
}

/** For the simulator tools, which return human text + structuredContent. */
async function callStructured(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: result.isError === true,
    data: result.structuredContent ?? {},
    text: result.content?.[0]?.text ?? "",
  };
}

/**
 * tools/list as raw JSON-RPC (2025-era framing, which both entries still
 * serve), bypassing the client SDK's schema parsing so extension fields such
 * as `securitySchemes` survive.
 */
async function rawToolsList() {
  const request = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  if (httpUrl) {
    const response = await fetch(httpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify(request),
    });
    const text = await response.text();
    const json = text.startsWith("{") ? text : (text.match(/^data: (.*)$/m)?.[1] ?? "{}");
    return JSON.parse(json).result?.tools ?? [];
  }
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["dist/index.js"], { stdio: ["pipe", "pipe", "ignore"], env: stdioEnv });
  const done = new Promise((resolve, reject) => {
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (const line of buffer.split("\n")) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === 1) resolve(message.result?.tools ?? []);
        } catch {
          // partial line — keep buffering
        }
      }
    });
    child.on("error", reject);
    setTimeout(() => reject(new Error("raw stdio tools/list timed out")), 15_000).unref();
  });
  const init = {
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke-raw", version: "0" } },
  };
  child.stdin.write(`${JSON.stringify(init)}\n${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n${JSON.stringify(request)}\n`);
  try {
    return await done;
  } finally {
    child.kill();
  }
}

const only = process.argv.includes("--only")
  ? new Set(process.argv[process.argv.indexOf("--only") + 1].split(","))
  : null;

const client = new Client({ name: "smoke", version: "0.0.0" });
const transport = httpUrl
  ? new StreamableHTTPClientTransport(new URL(httpUrl))
  : new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env: stdioEnv });
await client.connect(transport);
console.log(`Connected via ${httpUrl ? `HTTP (${httpUrl})` : "stdio"}\n`);

const suites = [
  ["surface", () => import("./smoke/surface.mjs")],
  ["account", () => import("./smoke/account.mjs")],
  ["discovery", () => import("./smoke/discovery.mjs"), { httpOnly: true }],
  ["claude-surface", () => import("./smoke/claude-surface.mjs")],
  ["journal", () => import("./smoke/journal.mjs")],
  ["broker", () => import("./smoke/broker.mjs"), { stdioOnly: true }],
  ["library", () => import("./smoke/library.mjs")],
  ["propfirms", () => import("./smoke/propfirms.mjs")],
  // In-process against dist/, on the Claude surface; not a deployment check.
  ["claude-freeze", () => import("./smoke/claude-freeze.mjs"), { stdioOnly: true }],
  ["trackers", () => import("./smoke/trackers.mjs")],
  ["edge", () => import("./smoke/edge.mjs")],
  ["answers-surfaces", () => import("./smoke/answers-surfaces.mjs"), { httpOnly: true }],
];

const context = { client, check, callJson, callStructured, httpUrl, rawToolsList };
for (const [name, load, options = {}] of suites) {
  if (only && !only.has(name)) continue;
  if (options.stdioOnly && httpUrl) continue;
  if (options.httpOnly && !httpUrl) continue;
  console.log(`\n== ${name}`);
  const { run } = await load();
  await run(context);
}

await client.close();
console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);

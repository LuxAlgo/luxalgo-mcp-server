/*
  End-to-end smoke test: connects a real MCP client to the built server
  over stdio, lists tools, and calls all of them against the live LuxAlgo
  endpoints. Pass --http <url> to test a running streamable-HTTP server
  instead. Exits non-zero on any failure.

  One suite per tool domain under smoke/ (mirroring src/tools/), plus
  `surface` (tools/list, securitySchemes, serverInfo). Run a subset with
  --only <suite>[,<suite>], e.g. `node test/smoke.mjs --only library,edge`.
*/
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const httpUrl = process.argv.includes("--http")
  ? process.argv[process.argv.indexOf("--http") + 1]
  : null;

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
  const child = spawn(process.execPath, ["dist/index.js"], { stdio: ["pipe", "pipe", "ignore"] });
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
  : new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] });
await client.connect(transport);
console.log(`Connected via ${httpUrl ? `HTTP (${httpUrl})` : "stdio"}\n`);

const suites = [
  ["surface", () => import("./smoke/surface.mjs")],
  ["account", () => import("./smoke/account.mjs")],
  ["broker", () => import("./smoke/broker.mjs"), { stdioOnly: true }],
  ["library", () => import("./smoke/library.mjs")],
  ["propfirms", () => import("./smoke/propfirms.mjs")],
  ["trackers", () => import("./smoke/trackers.mjs")],
  ["edge", () => import("./smoke/edge.mjs")],
];

const context = { client, check, callJson, callStructured, httpUrl, rawToolsList };
for (const [name, load, options = {}] of suites) {
  if (only && !only.has(name)) continue;
  if (options.stdioOnly && httpUrl) continue;
  console.log(`\n== ${name}`);
  const { run } = await load();
  await run(context);
}

await client.close();
console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);

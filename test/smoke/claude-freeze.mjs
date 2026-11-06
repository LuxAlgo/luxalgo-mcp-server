/*
  The Claude address is frozen while Anthropic reviews it: the prop-firm
  directory tools' definitions on that surface (claude.mcp.luxalgo.com) must
  stay byte-identical to the reviewed build, and their results must not pick
  up the search improvements made for the other addresses.

  Builds the server in-process on the Claude surface (exactly as the hosted
  entry does inside the gate) and speaks raw JSON-RPC to it, so every byte
  of tools/list is compared, extension fields included. The reviewed
  definitions live in fixtures/claude-propfirms-tools.json; regenerate it
  only when a change to the Claude address is meant to ship:

    node test/smoke/claude-freeze.mjs --write
*/
import { readFile, writeFile } from "node:fs/promises";
import { InMemoryTransport } from "@modelcontextprotocol/client";

const FIXTURE = new URL("./fixtures/claude-propfirms-tools.json", import.meta.url);
const APP_ORIGIN = process.env.LUXALGO_APP_ORIGIN ?? "https://app.luxalgo.com";

/** The directory tools this surface shares with the others. */
const FROZEN_TOOLS = ["propfirms_search", "propfirms_get", "propfirms_search_challenges"];

/** A raw JSON-RPC session with a server built on the Claude surface. */
async function claudeSession() {
  const { createLuxalgoServer } = await import("../../dist/server/create-server.js");
  const { CLAUDE_SURFACE, runOnSurface } = await import("../../dist/auth/surface.js");
  const server = runOnSurface(CLAUDE_SURFACE, () => createLuxalgoServer({ entry: "hosted" }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const pending = new Map();
  clientSide.onmessage = (message) => {
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  await runOnSurface(CLAUDE_SURFACE, () => server.connect(serverSide));
  await clientSide.start();
  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      runOnSurface(CLAUDE_SURFACE, () => clientSide.send({ jsonrpc: "2.0", id, method, params }));
    });
  await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "claude-freeze", version: "0" },
  });
  await clientSide.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { request, close: () => server.close() };
}

async function frozenDefinitions(session) {
  const listed = await session.request("tools/list", {});
  const tools = listed.result?.tools ?? [];
  return FROZEN_TOOLS.map((name) => tools.find((tool) => tool.name === name) ?? { name, missing: true });
}

export async function run({ check }) {
  const session = await claudeSession();
  try {
    const actual = await frozenDefinitions(session);
    const expected = JSON.parse(await readFile(FIXTURE, "utf8"));
    for (const [index, name] of FROZEN_TOOLS.entries()) {
      check(
        `on the Claude address, ${name} is defined exactly as in the reviewed build`,
        JSON.stringify(actual[index]) === JSON.stringify(expected[index]),
        `${JSON.stringify(actual[index]).length} bytes`,
      );
    }

    // Results: a natural query is passed to the app as-is on Claude, exactly
    // as before — same rows the app returns for that text, nothing added.
    const call = async (args) => {
      const response = await session.request("tools/call", { name: "propfirms_search_challenges", arguments: args });
      const text = response.result?.content?.[0]?.text ?? "";
      return { isError: response.result?.isError === true, text };
    };
    const raw = await (
      await fetch(`${APP_ORIGIN}/api/propfirms/challenges/query?text=${encodeURIComponent("FTMO 100K")}&pageQuantity=3`)
    ).json();
    const natural = await call({ text: "FTMO 100K", pageQuantity: 3 });
    const payload = JSON.parse(natural.text || "{}");
    check(
      "on the Claude address, a search for 'FTMO 100K' returns what the app returns for that text, unchanged",
      !natural.isError &&
        Object.keys(payload).every((key) => ["count", "challenges", "offers", "warnings"].includes(key)) &&
        payload.count === raw.data.count &&
        payload.challenges.map((c) => c.challengeId).join() === raw.data.challenges.map((c) => c.challengeId).join(),
      natural.text.slice(0, 80),
    );
    const single = await call({ propfirmId: "ftmo" });
    check(
      "on the Claude address, propfirmId still takes only a list, as reviewed",
      single.isError,
      single.text.slice(0, 80),
    );
  } finally {
    await session.close();
  }
}

// `node test/smoke/claude-freeze.mjs --write` records the current build as the reviewed one.
if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes("--write")) {
  const session = await claudeSession();
  await writeFile(FIXTURE, `${JSON.stringify(await frozenDefinitions(session), null, 2)}\n`);
  await session.close();
  console.log(`wrote ${FIXTURE.pathname}`);
}

/*
  Which answers each address gives (HTTP only).

  The Claude address is under directory review as submitted: its tool
  definitions must stay byte-identical (their hash is pinned below) and its
  results keep the reviewed shape and wording. The answer improvements of
  the standard address (checked in the domain suites over stdio or HTTP)
  also reach the OpenAI address.

  REVIEWED_CLAUDE_TOOLS is the sha256 of the Claude address's tools/list
  `tools` array (JSON.stringify, as served). It equals what
  https://claude.mcp.luxalgo.com/mcp served on 2026-11-06. Change it only
  together with a new submission of the Claude directory listing.
*/
import { createHash } from "node:crypto";

const REVIEWED_CLAUDE_TOOLS = "f2233dd025f31f7187f8d85f09f0cf240855182511781ef643bd4bba57996907";

export async function run({ check, httpUrl }) {
  const standard = new URL(httpUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(standard.hostname);
  const claude = new URL(httpUrl);
  claude.hostname = `claude.${claude.hostname}`;
  const openai = new URL(`${standard.pathname.replace(/\/+$/, "")}/openai`, standard);

  const rpc = async (address, method, params) => {
    const target = address === "claude" && !local ? claude : address === "openai" ? openai : standard;
    const response = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(address === "claude" && local ? { "x-forwarded-host": claude.host } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await response.text();
    return JSON.parse(text.startsWith("{") ? text : (text.match(/^data: (.*)$/m)?.[1] ?? "{}")).result ?? {};
  };
  const call = async (address, name, args) => {
    const result = await rpc(address, "tools/call", { name, arguments: args });
    return { isError: result.isError === true, text: result.content?.[0]?.text ?? "", data: result.structuredContent ?? {} };
  };

  // Claude: definitions exactly as reviewed.
  const { tools = [] } = await rpc("claude", "tools/list", {});
  const hash = createHash("sha256").update(JSON.stringify(tools)).digest("hex");
  check(
    "on the Claude address every tool definition is exactly the reviewed one",
    hash === REVIEWED_CLAUDE_TOOLS,
    `${tools.length} tools, sha256 ${hash.slice(0, 12)}…`,
  );

  // Claude: results keep the reviewed shape and wording.
  const list = await call("claude", "propfirms_list_simulatable", {});
  const firm = list.data.firms?.find((f) => f.challenges?.length >= 2);
  check(
    "on the Claude address the simulatable-firm list still carries every challenge",
    !list.isError && list.data.firms?.length > 0 && list.data.firms.every((f) => Array.isArray(f.challenges)),
    `${list.data.firms?.length} firms, ${list.text.length + JSON.stringify(list.data).length} B`,
  );
  const sim = await call("claude", "propfirms_simulate", {
    firmId: firm.firmId,
    challengeId: firm.challenges[0].challengeId,
    winRate: 0.48,
    avgWinR: 1.6,
    tradesPerDay: 4,
    riskValue: 1,
    paths: 1000,
  });
  check(
    "on the Claude address simulation text keeps the reviewed wording",
    !sim.isError && /expected total cost: /.test(sim.text) && /^Assumptions(: none flagged| \(\d+ flags - relay these to the user\))/m.test(sim.text),
    sim.text.split("\n").find((line) => line.startsWith("Assumptions")),
  );
  const dossier = await call("claude", "propfirms_get", { propfirmId: "ftmo" });
  const dossierFirm = JSON.parse(dossier.text || "{}").firm ?? {};
  check(
    "on the Claude address a prop firm's dossier is the full one, FAQ included",
    !dossier.isError && "faq" in (dossierFirm.overview ?? {}) && !("omitted" in dossierFirm) && !("url" in dossierFirm),
    `${dossier.text.length} B`,
  );
  const family = await call("claude", "library_get_family", { key: "trend" });
  check(
    "on the Claude address a family hub still lists its concepts next to the page",
    !family.isError && Array.isArray(JSON.parse(family.text || "{}").concepts),
    `${family.text.length} B`,
  );

  // OpenAI: the same plain answers as the standard address.
  const openList = await call("openai", "propfirms_list_simulatable", {});
  check(
    "on the OpenAI address the simulatable-firm list is one line per firm",
    !openList.isError && openList.data.firms?.length > 0 && openList.data.firms.every((f) => !("challenges" in f)),
    `${openList.text.length + JSON.stringify(openList.data).length} B`,
  );
  const openSim = await call("openai", "propfirms_simulate", {
    firmId: firm.firmId,
    challengeId: firm.challenges[0].challengeId,
    winRate: 0.48,
    avgWinR: 1.6,
    tradesPerDay: 4,
    riskValue: 1,
    paths: 1000,
  });
  check(
    "on the OpenAI address simulation text states facts, with the fee in words",
    !openSim.isError && !/relay|to the user/i.test(openSim.text) && /average cost across attempts/.test(openSim.text),
    openSim.text.split("\n").find((line) => line.includes("average cost")),
  );
  const symbols = JSON.parse((await call("openai", "edge_symbols", {})).text || "{}").symbols ?? [];
  const crypto = symbols.find((s) => s.assetClass === "crypto")?.symbol;
  if (crypto) {
    const gap = await call("openai", "edge_report", { preset: "gap-fill", symbol: crypto });
    check(
      `on the OpenAI address gap statistics on ${crypto} are refused with the reason`,
      gap.isError && /trades around the clock/.test(gap.text),
      gap.text.slice(0, 80),
    );
  }
}

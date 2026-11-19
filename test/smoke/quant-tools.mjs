/*
  Quant, our coding agent, for the member's AI assistant (opt-in:
  LUXALGO_QUANT_TOOLS=on or a Vercel preview): Pine Script® generation and
  linting, the member's scripts, and backtest loops. Generating, planning and
  a running loop use the member's Quant usage, which the LuxAlgo app meters. A
  script that passes is kept in the member's account; a loop is planned,
  started, stopped and followed, and what it found is read by id: its info
  names its strategies, best first, and a strategy's id reads its code and
  backtests.

  1. The server under test: when it lists these tools, an anonymous read, an
     anonymous generation and an anonymous start meet the sign-in challenge
     (401 hosted, in-band on stdio).
  2. A node-http entry this suite starts with the tools on: the standard and
     the ChatGPT addresses list them, protected, with their annotations
     (starting a loop is the one marked destructive; the reads are read-only);
     anonymous calls are refused with 401; the Claude address lists none of
     them and its tool list is byte for byte the one under review.
  3. A stdio entry signed in to a stand-in for the app's Quant routes: a script
     is checked, written, changed, found and read; a loop is planned (nothing
     starts), started once from its plan id, read, its best strategy read
     with its backtests, and stopped; the app's
     refusals (out of usage, a plan that cannot run loops, an unknown plan,
     the routes switched off) come back in words and start nothing. The
     stand-in records any call outside the app's MCP allowlist for these
     tools, and the suite fails if there is one.
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
import { QUANT } from "./surface.mjs";
import { CLAUDE_TOOLS_SHA256 } from "./claude-surface.mjs";

const TOKEN = "stand-in-token";
const READ = ["quant_list_backtest_loops", {}];
const GENERATE = ["quant_generate_pine_script", { prompt: "smoke test: must never reach Quant" }];
const START = ["quant_start_backtest_loop", { plan_id: "plan_smoke" }];
/** The tools that spend the member's Quant usage. */
const SPENDING = ["quant_generate_pine_script", "quant_plan_backtest_loop", "quant_start_backtest_loop"];

export async function run({ client, check, httpUrl }) {
  await underTest(client, check, httpUrl);
  await addresses(check);
  await signedIn(check);
}

// ── 1. the server under test ────────────────────────────────────────────────

async function underTest(client, check, httpUrl) {
  const { tools } = await client.listTools();
  if (!tools.some((t) => QUANT.includes(t.name))) {
    console.log("(Quant tools are off on the server under test; set LUXALGO_QUANT_TOOLS=on to check them there too)");
    return;
  }
  for (const [name, args] of [READ, GENERATE, START]) {
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
        `stdio ${name} without a sign-in answers the in-band OAuth challenge and spends nothing`,
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
      `with the Quant tools on, the standard address lists all ${QUANT.length} of them, each asking for a LuxAlgo sign-in`,
      QUANT.every((name) => {
        const tool = standardTools?.tools?.find((t) => t.name === name);
        return tool?.securitySchemes?.some((s) => s.type === "oauth2") && / Requires signing in with a LuxAlgo account \(OAuth\)\.$/.test(tool.description);
      }),
      `${names(standardTools).filter((n) => QUANT.includes(n)).length} of ${QUANT.length}`,
    );
    check("the ChatGPT address lists them too", QUANT.every((name) => names(openaiTools).includes(name)), names(openaiTools).filter((n) => QUANT.includes(n)).join(", "));
    const digest = createHash("sha256").update(JSON.stringify(claudeTools?.tools ?? [])).digest("hex");
    check(
      "the Claude address lists none of them and stays byte for byte the tool list under review",
      names(claudeTools).every((n) => !QUANT.includes(n)) && digest === CLAUDE_TOOLS_SHA256,
      `${claudeTools?.tools?.length} tools, sha256 ${digest.slice(0, 12)}…`,
    );

    const statuses = [];
    for (const [name, args] of [READ, GENERATE, START]) {
      const response = await post(standard.url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      statuses.push(`${name} ${response.status}`);
    }
    check("on the standard address, an anonymous read, generation and start are refused with 401", statuses.every((s) => s.endsWith(" 401")), statuses.join("; "));

    const tool = (name) => standardTools?.tools?.find((t) => t.name === name) ?? {};
    const a = (name) => tool(name).annotations ?? {};
    check(
      "starting a backtest loop is the one tool marked destructive, so chat apps ask the member before it runs",
      a("quant_start_backtest_loop").destructiveHint === true &&
        a("quant_start_backtest_loop").readOnlyHint === false &&
        QUANT.filter((n) => n !== "quant_start_backtest_loop").every((n) => a(n).destructiveHint === false),
      JSON.stringify(a("quant_start_backtest_loop")),
    );
    const reads = QUANT.filter((n) => !SPENDING.includes(n) && n !== "quant_stop_backtest_loop");
    check(
      "checking a script and reading scripts, loops and strategies change nothing: read-only",
      reads.every((n) => a(n).readOnlyHint === true) && [...SPENDING, "quant_stop_backtest_loop"].every((n) => a(n).readOnlyHint === false),
      reads.filter((n) => a(n).readOnlyHint !== true).join(", ") || `${reads.length} read-only`,
    );
    check(
      "every tool that spends the member's Quant usage says so, and checking a script says it uses none",
      SPENDING.every((n) => /Quant usage/.test(tool(n).description)) && /uses no Quant usage/.test(tool("quant_validate_pine_script").description),
      SPENDING.filter((n) => !/Quant usage/.test(tool(n).description)).join(", ") || "all",
    );
    check(
      "planning tells the model to show the plan and wait for the member's yes; starting says to call it only after that yes",
      /wait for their yes before calling quant_start_backtest_loop/.test(tool("quant_plan_backtest_loop").description) &&
        /only after you showed the member that plan and they said yes/.test(tool("quant_start_backtest_loop").description),
    );
    check(
      "the tools say how to answer \"what was the best strategy of my latest loop?\": the list is newest first, the info names the best strategy, the strategy tool reads it",
      /newest first/.test(tool("quant_list_backtest_loops").description) &&
        /best_strategy_id/.test(tool("quant_get_backtest_loop_info").description) &&
        /quant_get_backtest_loop_strategy/.test(tool("quant_get_backtest_loop_info").description) &&
        /quant_list_backtest_loops \(newest first\), then quant_get_backtest_loop_info, then this/.test(tool("quant_get_backtest_loop_strategy").description),
    );
    check(
      "reading a strategy says its numbers are backtests, not predictions, and that it uses no Quant usage",
      /never a prediction or trading advice/.test(tool("quant_get_backtest_loop_strategy").description) &&
        /uses no Quant usage/.test(tool("quant_get_backtest_loop_strategy").description),
    );
    const required = (name) => (tool(name).inputSchema?.required ?? []).slice().sort().join();
    check(
      "a loop starts from a plan id, and is stopped and followed by its loop id; a script is written from a prompt, optionally for a script or a saved script id",
      required("quant_start_backtest_loop") === "plan_id" &&
        required("quant_stop_backtest_loop") === "loop_id" &&
        required("quant_get_backtest_loop_info") === "loop_id" &&
        required("quant_get_backtest_loop_strategy") === "strategy_id" &&
        required("quant_generate_pine_script") === "prompt" &&
        ["code", "script_id"].every((p) => Object.keys(tool("quant_generate_pine_script").inputSchema?.properties ?? {}).includes(p)) &&
        required("quant_validate_pine_script") === "code",
      QUANT.map((n) => `${n}(${required(n)})`).join(" "),
    );
    const copy = QUANT.map((n) => `${tool(n).title} ${tool(n).description}`).join(" ");
    const banned = [/QuantCharts/, /Quant AI/, /\bpane\b/i, /AI credits/i, /guarantee/i, /Pine Script(?!®)/];
    check(
      "their copy names Pine Script® with its mark and has none of the retired terms or promises",
      banned.every((re) => !re.test(copy)),
      banned.filter((re) => re.test(copy)).join(", ") || "clean",
    );
  } finally {
    entry.stop();
  }
}

// ── 3. signed in, against a stand-in for the app ─────────────────────────────

const VALID_SCRIPT = '//@version=6\nindicator("Smoke EMA", overlay = true)\nplot(ta.ema(close, 20))\n';
const BROKEN_SCRIPT = '//@version=6\nindicator("Broken")\nplot(ta.ema(close))\n';

async function signedIn(check) {
  const app = await startStandIn();
  const dir = await mkdtemp(join(tmpdir(), "luxalgo-quant-tools-"));
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
  const member = new Client({ name: "quant-tools-smoke", version: "0" });
  await member.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: { ...getDefaultEnvironment(), LUXALGO_APP_ORIGIN: app.origin, LUXALGO_MCP_AUTH_FILE: authFile, LUXALGO_QUANT_TOOLS: "on" },
      stderr: "ignore",
    }),
  );
  const call = async (name, args = {}) => {
    const result = await member.callTool({ name, arguments: args });
    return { isError: result.isError === true, text: result.content?.[0]?.text ?? "", data: result.structuredContent ?? {} };
  };
  const { state } = app;
  try {
    // Pine Script®: check, write, change.
    const valid = await call("quant_validate_pine_script", { code: VALID_SCRIPT });
    const broken = await call("quant_validate_pine_script", { code: BROKEN_SCRIPT });
    check(
      "checking a script answers whether it is valid, each error with its line, and what the script declares, and spends nothing",
      !valid.isError &&
        /^Valid: no errors/.test(valid.text) &&
        valid.data.script?.title === "Smoke EMA" &&
        !broken.isError &&
        broken.data.valid === false &&
        /^Not valid: 1 error\.\n- line 3:6 PINE_ARGS: /.test(broken.text) &&
        state.generations === 0,
      `${valid.text.slice(0, 60)} | ${broken.text.slice(0, 80)}`,
    );

    const written = await call("quant_generate_pine_script", { prompt: "a 20 period EMA on the chart" });
    const sent = state.calls.findLast((c) => c.path.endsWith("/generations"))?.body ?? {};
    check(
      "a prompt comes back as a script that passes the linter, in a Pine Script® code block and as structured content",
      !written.isError &&
        /^Written by Quant in 1 attempt\. It passes LuxAlgo's linter\./.test(written.text) &&
        written.text.includes("```pine\n//@version=6") &&
        written.data.valid === true &&
        written.data.code === VALID_SCRIPT &&
        written.data.diff === null,
      written.text.slice(0, 120),
    );
    check(
      "a script that passes is saved to the member's account as one of their Quant scripts, and the result gives its script id",
      /It is saved to the member's LuxAlgo account as one of their Quant scripts \(script id scr_new_1\)\./.test(written.text) &&
        written.data.saved === true &&
        written.data.script_id === "scr_new_1" &&
        written.data.saved_as === "new_script",
      written.text.slice(0, 120),
    );
    check(
      "a generation is given a time budget that fits the hosted entry's 60 second limit",
      Number.isInteger(sent.timeoutSeconds) && sent.timeoutSeconds >= 15 && sent.timeoutSeconds < 60 && sent.code === undefined,
      `timeoutSeconds ${sent.timeoutSeconds}`,
    );

    const changed = await call("quant_generate_pine_script", { prompt: "make it 50", code: VALID_SCRIPT });
    check(
      "a script passed as code is changed in place: the result says so and carries a diff",
      !changed.isError && /^Changed by Quant/.test(changed.text) && typeof changed.data.diff === "string" && changed.data.diff.includes("-plot"),
      changed.text.slice(0, 80),
    );

    const versioned = await call("quant_generate_pine_script", { prompt: "make it 50", script_id: "scr_user" });
    const versionedSent = state.calls.findLast((c) => c.path.endsWith("/generations"))?.body ?? {};
    const notMine = await call("quant_generate_pine_script", { prompt: "make it 50", script_id: "scr_someone_elses" });
    check(
      "one of the member's saved scripts is changed by its id, from its saved source, and saved as its new version; an id that is not theirs is not found",
      !versioned.isError &&
        versionedSent.scriptId === "scr_user" &&
        versionedSent.code === undefined &&
        /^Changed by Quant in 1 attempt\. It passes LuxAlgo's linter\. It is saved as the new version of the member's script scr_user\./.test(versioned.text) &&
        versioned.data.saved_as === "new_version" &&
        versioned.data.script_id === "scr_user" &&
        notMine.isError &&
        /^No script was written: script not found/.test(notMine.text),
      `${versioned.text.slice(0, 130)} | ${notMine.text}`,
    );

    const stillBroken = await call("quant_generate_pine_script", { prompt: "leave an error" });
    check(
      "a script that does not pass yet is returned with its errors and how to fix them, and is not saved",
      !stillBroken.isError &&
        /does not pass LuxAlgo's linter yet \(1 error\), so it was not saved/.test(stillBroken.text) &&
        /again with this script as `code`/.test(stillBroken.text) &&
        stillBroken.data.valid === false &&
        stillBroken.data.saved === false &&
        stillBroken.data.script_id === null &&
        stillBroken.data.status === "incomplete",
      stillBroken.text.slice(0, 140),
    );

    const nothing = await call("quant_generate_pine_script", { prompt: "run out of time" });
    check(
      "when Quant's time runs out before any script, the result is an error that says so",
      nothing.isError && /^No script was written: Quant ran out of time/.test(nothing.text) && nothing.data.code === null,
      nothing.text,
    );

    const declined = await call("quant_generate_pine_script", { prompt: "write it in python instead" });
    check(
      "a request Quant declines is an error that carries Quant's own reason",
      declined.isError && declined.text === "No script was written: Quant declined this request. I can't write that: here I only write Pine Script® v6.",
      declined.text,
    );

    state.outOfUsage = true;
    const spent = await call("quant_generate_pine_script", { prompt: "anything" });
    state.outOfUsage = false;
    check(
      "out of Quant usage, the app's refusal comes back in its own words and nothing is generated",
      spent.isError && /^No script was written: You've reached your weekly limit/.test(spent.text),
      spent.text,
    );

    // The member's scripts.
    const found = await call("quant_search_user_scripts", { query: "ema" });
    const sourceless = JSON.stringify(found.data).includes("//@version");
    check(
      "searching the member's scripts finds Quant's and their own by name, with ids and no source",
      !found.isError &&
        found.data.total === 2 &&
        found.data.scripts?.map((s) => `${s.id}:${s.origin}`).join() === "scr_quant:quant,scr_user:user" &&
        !sourceless &&
        /with get_user_script\./.test(found.text),
      found.text.slice(0, 160),
    );
    const script = await call("get_user_script", { script_id: "scr_quant" });
    const missing = await call("get_user_script", { script_id: "scr_someone_elses" });
    check(
      "one of the member's scripts is read in full by its id; an id that is not theirs is not found",
      !script.isError && script.data.code === VALID_SCRIPT && script.text.includes("```pine") && missing.isError && /script not found/.test(missing.text),
      `${script.text.slice(0, 60)} | ${missing.text}`,
    );

    // Backtest loops: plan, start, read, stop.
    const planned = await call("quant_plan_backtest_loop", { prompt: "long only BTCUSDT 1h, profit factor at least 1.5, 30 minutes" });
    check(
      "a prompt becomes a plan with a plan id, described in words with Quant's estimate, and starts nothing",
      !planned.isError &&
        /^Planned, not started: 1 market: BTCUSDT on 1 hour bars, 2024-01-01 to 2025-12-31, 30% of it held out, long only: profit_factor at least 1\.5/.test(planned.text) &&
        /order size 10% of equity\. It looks for 1 strategy that passes every market, for up to 30 minutes\./.test(planned.text) &&
        /Quant's estimate that it finds one: 35%/.test(planned.text) &&
        /on their yes, call quant_start_backtest_loop/.test(planned.text) &&
        planned.data.plan_id === "plan_1" &&
        planned.data.can_start === true &&
        state.started.length === 0,
      planned.text.slice(0, 220),
    );

    const unknown = await call("quant_start_backtest_loop", { plan_id: "plan_madeup" });
    check(
      "a plan id that is not one of the member's plans starts nothing",
      unknown.isError && /^Nothing was started: Plan not found/.test(unknown.text) && state.started.length === 0,
      unknown.text,
    );

    const started = await call("quant_start_backtest_loop", { plan_id: planned.data.plan_id });
    const again = await call("quant_start_backtest_loop", { plan_id: planned.data.plan_id });
    check(
      "with the member's yes, the plan id starts its loop once: starting it again answers the same loop",
      !started.isError &&
        /^Started: the backtest loop is running/.test(started.text) &&
        started.data.loop_id === "loop_1" &&
        started.data.running === true &&
        started.data.report_url === "https://vela.luxalgo.com/chart?chat=plan_1&loopReport=loop_1" &&
        started.text.includes("Its Loop Report in Vela: https://vela.luxalgo.com/chart?chat=plan_1&loopReport=loop_1") &&
        // Starting hands back the loop's id, never a strategy.
        !/strateg(y|ies)"|"code"/.test(JSON.stringify(started.data)) &&
        again.data.loop_id === "loop_1" &&
        state.started.length === 1,
      started.text.slice(0, 120),
    );

    state.planAccess = "upgrade";
    const lowerPlan = await call("quant_plan_backtest_loop", { prompt: "the same, on a plan without loops" });
    const refused = await call("quant_start_backtest_loop", { plan_id: lowerPlan.data.plan_id });
    state.planAccess = "run";
    check(
      "on a plan that cannot run loops, the plan says so and starting it is the app's refusal, relayed as the upgrade answer",
      !lowerPlan.isError &&
        lowerPlan.data.can_start === false &&
        /backtest loops run on the Ultimate and Ultra plans/.test(lowerPlan.text) &&
        refused.isError &&
        /Your LuxAlgo plan does not include this/.test(refused.text) &&
        state.started.length === 1,
      `${lowerPlan.text.slice(-120)} | ${refused.text.slice(0, 100)}`,
    );

    const listed = await call("quant_list_backtest_loops");
    const active = await call("quant_list_backtest_loops", { active: true });
    check(
      "the member's loops are listed with their ids and whether each is active; active: true keeps only those still going",
      !listed.isError &&
        listed.data.loops?.map((l) => `${l.id}:${l.active}`).join() === "loop_1:true,loop_old:false" &&
        active.data.loops?.map((l) => l.id).join() === "loop_1" &&
        /^2 backtest loops, 1 active\./.test(listed.text),
      listed.text.slice(0, 160),
    );

    // "In my most recent loop, what was the best strategy?": the list's first loop, its info, then that strategy.
    const latest = listed.data.loops?.[0]?.id;
    const info = await call("quant_get_backtest_loop_info", { loop_id: latest });
    check(
      "a loop's info says where it stands and names what it found: its strategies by id, the one that meets every criterion first, without their code",
      !info.isError &&
        latest === "loop_1" &&
        info.data.loop?.status === "running" &&
        info.data.loop?.active === true &&
        info.data.loop?.strategies_found === 1 &&
        info.data.loop?.report_url === "https://vela.luxalgo.com/chart?chat=plan_1&loopReport=loop_1" &&
        info.data.loop?.best_strategy_id === "loop_1.2" &&
        info.data.loop?.strategies?.map((s) => `${s.id}:${s.meets_every_criterion}`).join() === "loop_1.2:true,loop_1.1:false" &&
        /^BTCUSDT 1 hour: running, 1 of 1 found in 2 attempts\. Its best strategy is loop_1\.2 \(attempt 2\), which meets every criterion; read it with quant_get_backtest_loop_strategy\. Its Loop Report in Vela: https:\/\/vela\.luxalgo\.com\/chart\?/.test(info.text) &&
        !/"code"/.test(JSON.stringify(info.data)),
      info.text.slice(0, 220),
    );

    const best = await call("quant_get_backtest_loop_strategy", { strategy_id: info.data.loop?.best_strategy_id });
    const market = best.data.strategy?.markets?.[0];
    check(
      "the best strategy is read by its id: what it does, its Pine Script® source, and the market's backtest in sample and held out, with every criterion against its threshold",
      !best.isError &&
        best.data.strategy?.id === "loop_1.2" &&
        best.data.strategy?.loop_id === "loop_1" &&
        best.data.strategy?.meets_every_criterion === true &&
        best.data.strategy?.code === STRATEGY_SCRIPT &&
        market?.ticker === "BTCUSDT" &&
        market?.in_sample?.metrics?.profit_factor === 1.82 &&
        market?.in_sample?.backtest?.sharpe_ratio === 1.4 &&
        market?.in_sample?.criteria?.[0]?.value === 1.82 &&
        market?.in_sample?.criteria?.[0]?.min === 1.5 &&
        market?.out_of_sample?.metrics?.profit_factor === 1.61 &&
        market?.out_of_sample?.passed === true &&
        best.data.strategy?.report_url === "https://vela.luxalgo.com/chart?chat=plan_1&loopReport=loop_1",
      JSON.stringify(market?.in_sample?.metrics ?? null),
    );
    check(
      "its numbers are said in words as backtests, in sample and held out apart, with the source in a Pine Script® code block",
      /^Strategy loop_1\.2, attempt 2 of loop loop_1: it meets every criterion on every market, held-out data included\. Buys when the fast EMA crosses above the slow one\./.test(best.text) &&
        /BTCUSDT 1 hour\. In sample: net profit \$18,250, profit factor 1\.82, 96 trades, win rate 54\.2%, max drawdown 8\.4%; meets its criteria\. Held out: net profit \$5,100, profit factor 1\.61, 31 trades, win rate 51\.6%, max drawdown 6\.9%; meets its criteria\./.test(best.text) &&
        /Backtests are history under the plan's assumptions, never a prediction or trading advice\./.test(best.text) &&
        best.text.endsWith(`\`\`\`pine\n${STRATEGY_SCRIPT.trimEnd()}\n\`\`\``),
      best.text.slice(0, 260),
    );

    const closest = await call("quant_get_backtest_loop_strategy", { strategy_id: "loop_1.1" });
    check(
      "a strategy that does not meet every criterion is said to fall short, with the criterion it failed, never rounded up to a pass",
      !closest.isError &&
        closest.data.strategy?.meets_every_criterion === false &&
        /it does not meet every criterion \(score 71 of 100 in sample\)/.test(closest.text) &&
        /In sample: net profit \$3,900, profit factor 1\.12, 140 trades, win rate 47\.1%, max drawdown 14\.2%; does not meet its criteria \(profit_factor\)\./.test(closest.text) &&
        /Held out: net profit -\$800, profit factor 0\.94, [^;]*; does not meet its criteria \(profit_factor\)\./.test(closest.text),
      closest.text.slice(0, 220),
    );

    const noStrategy = await call("quant_get_backtest_loop_strategy", { strategy_id: "loop_other.1" });
    check(
      "a strategy id that is not one of the member's is not found, in words",
      noStrategy.isError && /^The strategy was not read: Strategy not found/.test(noStrategy.text),
      noStrategy.text,
    );

    const empty = await call("quant_get_backtest_loop_info", { loop_id: "loop_old" });
    check(
      "a loop whose attempts never reached a backtest has no best strategy, and its info says so",
      !empty.isError &&
        empty.data.loop?.best_strategy_id === null &&
        empty.data.loop?.strategies?.length === 0 &&
        /No attempt has reached a backtest yet, so it has no strategy to read\./.test(empty.text),
      empty.text.slice(0, 200),
    );

    const allTools = (await member.listTools()).tools.map((t) => t.name);
    check(
      "the loop tools plan, start, stop, list, say where a loop stands and read a strategy it found; none puts a strategy on a chart or changes one",
      allTools.filter((n) => /backtest_loop/.test(n)).sort().join() ===
        "quant_get_backtest_loop_info,quant_get_backtest_loop_strategy,quant_list_backtest_loops,quant_plan_backtest_loop,quant_start_backtest_loop,quant_stop_backtest_loop",
      allTools.filter((n) => /backtest_loop/.test(n)).join(", "),
    );

    const stopped = await call("quant_stop_backtest_loop", { loop_id: "loop_1" });
    const stoppedAgain = await call("quant_stop_backtest_loop", { loop_id: "loop_1" });
    const afterStop = await call("quant_list_backtest_loops", { active: true });
    check(
      "stopping a loop ends it and keeps what it found; a loop that already stopped is left as it is",
      !stopped.isError &&
        stopped.data.stopped === true &&
        /^Stopped: the loop ends after the attempt it is on and keeps what it found/.test(stopped.text) &&
        stoppedAgain.data.stopped === false &&
        /^Nothing to stop: the loop already ended \(stopped\)\./.test(stoppedAgain.text) &&
        afterStop.data.loops?.length === 0,
      `${stopped.text.slice(0, 60)} | ${stoppedAgain.text}`,
    );

    const restarted = await call("quant_start_backtest_loop", { plan_id: planned.data.plan_id });
    check(
      "starting a plan whose loop already ended starts nothing new and says so, never that it is running",
      !restarted.isError &&
        /^Nothing new was started: this plan already started loop loop_1, which already ended \(stopped\)\./.test(restarted.text) &&
        restarted.data.running === false &&
        state.started.length === 1,
      restarted.text.slice(0, 140),
    );

    state.off = true;
    const off = await call("quant_list_backtest_loops");
    check("while the app has it switched off (404), the tool says it is not open yet", off.isError && /not open on this LuxAlgo account yet/.test(off.text), off.text);
    state.off = false;

    check(
      "every call carried the member's token and stayed on the app's allowlist for these tools",
      state.violations.length === 0 && state.calls.length > 0 && state.calls.every((c) => c.auth === `Bearer ${TOKEN}`),
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
  ["POST", /^\/api\/agents\/quant\/generations$/],
  ["POST", /^\/api\/agents\/quant\/pine\/lint$/],
  ["GET", /^\/api\/agents\/quant\/scripts$/],
  ["GET", /^\/api\/agents\/quant\/scripts\/[^/]+$/],
  ["POST", /^\/api\/agents\/quant\/backtest-loops\/plans$/],
  ["POST", /^\/api\/agents\/quant\/backtest-loops$/],
  ["GET", /^\/api\/agents\/quant\/backtest-loops$/],
  ["GET", /^\/api\/agents\/quant\/backtest-loops\/[^/]+$/],
  ["POST", /^\/api\/agents\/quant\/backtest-loops\/[^/]+\/stop$/],
  ["GET", /^\/api\/agents\/quant\/backtest-loops\/strategies\/[^/]+$/],
];

const STRATEGY_SCRIPT =
  '//@version=6\nstrategy("Smoke trend", overlay = true, initial_capital = 100000)\nif ta.crossover(ta.ema(close, 10), ta.ema(close, 30))\n    strategy.entry("Long", strategy.long)\n';

/** One market of a strategy on one dataset, as the app answers it. */
const strategyWindow = ({ passed, minimum, netProfit, profitFactor, trades, winRate, drawdown, from, to }) => ({
  passed,
  criteria: [{ metric: "profit_factor", min: minimum, max: null, value: profitFactor, passed, detail: null }],
  problems: [],
  metrics: { net_profit_ccy: netProfit, profit_factor: profitFactor, closed_trades: trades, win_rate_pct: winRate, max_drawdown_pct: drawdown },
  backtest: {
    from,
    to,
    bars: 12264,
    initialCapital: 100000,
    netProfit,
    grossProfit: netProfit * 2,
    grossLoss: netProfit,
    openProfit: 0,
    cagrPct: 9.1,
    maxDrawdown: 8400,
    maxDrawdownPct: drawdown,
    maxRunup: 21000,
    maxRunupPct: 21,
    sharpeRatio: 1.4,
    sortinoRatio: 2.1,
    buyAndHoldPnl: 40000,
    buyAndHoldPct: 40,
    strategyOutperformance: -21750,
  },
});

/** A loop's two strategies as the app answers them: attempt 2 meets every criterion, attempt 1 came close. */
const loopStrategies = (loop, reportUrl) => {
  const of = (attempt, passed, score, inSample, outOfSample) => ({
    id: `${loop.id}.${attempt}`,
    loopId: loop.id,
    attempt,
    passed,
    outcome: passed ? "passed" : "failed_criteria",
    score,
    family: "Trend following",
    description: "Buys when the fast EMA crosses above the slow one.",
    notes: "Widened the stop.",
    behavior: "~4 trades a month · holds ~18 bars",
    handedBack: false,
    scriptId: null,
    code: STRATEGY_SCRIPT,
    markets: [{ ticker: "BTCUSDT", timeframe: 60, inSample, outOfSample }],
    reportUrl,
  });
  const developed = { from: "2024-01-01T00:00:00.000Z", to: "2025-05-26T00:00:00.000Z", minimum: 1.5 };
  const heldOut = { from: "2025-05-26T01:00:00.000Z", to: "2025-12-31T23:00:00.000Z", minimum: 1.3 };
  return [
    of(
      2,
      true,
      100,
      strategyWindow({ ...developed, passed: true, netProfit: 18250, profitFactor: 1.82, trades: 96, winRate: 54.2, drawdown: 8.4 }),
      strategyWindow({ ...heldOut, passed: true, netProfit: 5100, profitFactor: 1.61, trades: 31, winRate: 51.6, drawdown: 6.9 }),
    ),
    of(
      1,
      false,
      71,
      strategyWindow({ ...developed, passed: false, netProfit: 3900, profitFactor: 1.12, trades: 140, winRate: 47.1, drawdown: 14.2 }),
      strategyWindow({ ...heldOut, passed: false, netProfit: -800, profitFactor: 0.94, trades: 44, winRate: 43.2, drawdown: 9.8 }),
    ),
  ];
};

const PINE_ERROR = { code: "PINE_ARGS", message: 'ta.ema is missing its "length" argument', line: 3, column: 6, end_line: 3, end_column: 19 };
const SCRIPT_INFO = { type: "indicator", title: "Smoke EMA", short_title: null, pine_version: 6, overlay: true };

async function startStandIn() {
  const state = { calls: [], violations: [], started: [], generations: 0, plans: new Map(), loops: new Map(), outOfUsage: false, planAccess: "run", off: false };
  const summary = (loop) => ({
    id: loop.id,
    status: loop.status,
    active: loop.status === "running" || loop.status === "paused_budget",
    markets: [{ ticker: "BTCUSDT", timeframe: 60 }],
    strategiesFound: 1,
    strategiesRequired: 1,
    attempts: 2,
    activeSeconds: 240,
    timeLimitSeconds: 1800,
    createdAt: "2026-11-18T10:00:00.000Z",
    finishedAt: loop.status === "running" ? null : "2026-11-18T10:30:00.000Z",
    reportUrl: reportUrl(loop),
  });
  const reportUrl = (loop) => `https://vela.luxalgo.com/chart?${loop.planId ? `chat=${loop.planId}&` : ""}loopReport=${loop.id}`;
  state.loops.set("loop_old", { id: "loop_old", status: "succeeded" });
  const scripts = [
    { id: "scr_quant", name: "Smoke EMA", type: "indicator", origin: "quant", description: "A 20 period EMA.", createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-03T00:00:00.000Z" },
    { id: "scr_user", name: "My EMA cross", type: "strategy", origin: "user", description: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
  ];

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
    const path = url.pathname;
    state.calls.push({ method: req.method, path, auth: req.headers.authorization, body });
    if (!ALLOWED.some(([method, re]) => method === req.method && re.test(path))) {
      state.violations.push(`${req.method} ${path}`);
      return send(404, { message: "Not found" });
    }
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: "unauthorized" });
    if (state.off) return send(404, { message: "Not available" });

    if (path.endsWith("/pine/lint")) {
      const valid = body.code === VALID_SCRIPT;
      return send(200, { valid, errors: valid ? [] : [PINE_ERROR], warnings: [], script: valid ? SCRIPT_INFO : { ...SCRIPT_INFO, title: "Broken", overlay: false } });
    }
    if (path.endsWith("/generations")) {
      if (state.outOfUsage) return send(429, { message: "You've reached your weekly limit. It resets on Monday." });
      state.generations += 1;
      // The member's own script ids, as the app checks them before anything is spent.
      if (body.scriptId && !scripts.some((s) => s.id === body.scriptId)) return send(404, { message: "script not found" });
      // A script that passes is kept: a new one, or the new version of the member's script that was named.
      const kept = body.scriptId ? { id: body.scriptId, created: false } : { id: `scr_new_${state.generations}`, created: true };
      const base = { id: `gen_${state.generations}`, status: "completed", stopReason: "passed", comment: null, attempts: 1, durationMs: 4200, savedScript: null };
      if (/run out of time/.test(body.prompt)) {
        return send(200, { ...base, status: "incomplete", stopReason: "timeout", code: null, diff: null, script: null, lint: { valid: null, errors: [], warnings: [] }, attempts: 0 });
      }
      if (/python/.test(body.prompt)) {
        return send(200, { ...base, stopReason: "refusal", code: null, diff: null, comment: "I can't write that: here I only write Pine Script® v6.", script: null, lint: { valid: null, errors: [], warnings: [] } });
      }
      if (/leave an error/.test(body.prompt)) {
        return send(200, { ...base, status: "incomplete", stopReason: "timeout", code: BROKEN_SCRIPT, diff: null, script: SCRIPT_INFO, lint: { valid: false, errors: [PINE_ERROR], warnings: [] } });
      }
      return send(200, {
        ...base,
        code: VALID_SCRIPT,
        diff: body.code || body.scriptId ? "--- a/script.pine\n+++ b/script.pine\n-plot(ta.ema(close, 20))\n+plot(ta.ema(close, 50))\n" : null,
        script: SCRIPT_INFO,
        lint: { valid: true, errors: [], warnings: [] },
        savedScript: kept,
      });
    }
    if (path === "/api/agents/quant/scripts") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const matches = scripts.filter((s) => s.name.toLowerCase().includes(q));
      return send(200, { scripts: matches, total: matches.length });
    }
    if (path.startsWith("/api/agents/quant/scripts/")) {
      const script = scripts.find((s) => s.id === decodeURIComponent(path.split("/").pop()));
      return script ? send(200, { script: { ...script, code: VALID_SCRIPT } }) : send(404, { message: "script not found" });
    }
    if (path.endsWith("/backtest-loops/plans")) {
      const planId = `plan_${state.plans.size + 1}`;
      state.plans.set(planId, { access: state.planAccess, loopId: null });
      return send(200, {
        planId,
        access: state.planAccess,
        assessment: { chancePct: 35, rationale: "A profit factor of 1.5 over two years is a high bar on one market." },
        plan: {
          strategies_required: 1,
          legs: [
            {
              ticker: "BTCUSDT",
              timeframe: 60,
              session: "regular",
              window: { from: Date.parse("2024-01-01T00:00:00Z"), to: Date.parse("2025-12-31T23:59:59Z"), out_of_sample_pct: 30, out_of_sample_at: "end" },
              costs: { commission: { value: 0.05, method: "percent" }, slippage_ticks: 1 },
              side: "long",
              criteria: [{ metric: "profit_factor", min: 1.5, max: null }],
            },
          ],
          capital: { initial_capital: 100000, order_size: { method: "percent_equity", value: 10 }, pyramiding: 1 },
          instructions: null,
          time_limit_minutes: 30,
        },
      });
    }
    if (path === "/api/agents/quant/backtest-loops" && req.method === "POST") {
      const plan = state.plans.get(body.planId);
      if (!plan) return send(404, { message: "Plan not found" });
      if (plan.access !== "run") return send(403, { message: "Backtest loops are available on the Ultimate and Ultra plans." });
      if (!plan.loopId) {
        plan.loopId = `loop_${state.started.length + 1}`;
        state.loops.set(plan.loopId, { id: plan.loopId, status: "running", planId: body.planId });
        state.started.push(plan.loopId);
      }
      const started = state.loops.get(plan.loopId);
      return send(200, { loopId: plan.loopId, status: started.status, reportUrl: reportUrl(started) });
    }
    if (path === "/api/agents/quant/backtest-loops") {
      const active = url.searchParams.get("active");
      // Newest first: the loop this run started, then the older one.
      const loops = [...state.loops.values()].reverse().map(summary).filter((l) => active === null || String(l.active) === active);
      return send(200, { loops });
    }
    if (path.endsWith("/stop")) {
      const loop = state.loops.get(decodeURIComponent(path.split("/").at(-2)));
      if (!loop) return send(404, { message: "Loop not found" });
      const stopped = loop.status === "running" || loop.status === "paused_budget";
      if (stopped) loop.status = "cancelled";
      return send(200, { stopped, status: loop.status });
    }
    // The loop this run started has two strategies; the older one never reached a backtest.
    const strategiesOf = (loop) => (loop.planId ? loopStrategies(loop, reportUrl(loop)) : []);
    if (path.startsWith("/api/agents/quant/backtest-loops/strategies/")) {
      const strategyId = decodeURIComponent(path.split("/").pop());
      const owner = state.loops.get(strategyId.slice(0, strategyId.lastIndexOf(".")));
      const strategy = owner ? strategiesOf(owner).find((candidate) => candidate.id === strategyId) : undefined;
      return strategy ? send(200, { strategy }) : send(404, { message: "Strategy not found" });
    }
    const loop = state.loops.get(decodeURIComponent(path.split("/").pop()));
    if (!loop) return send(404, { message: "Loop not found" });
    const strategies = strategiesOf(loop).map((strategy) => ({
      id: strategy.id,
      attempt: strategy.attempt,
      passed: strategy.passed,
      score: strategy.score,
      handedBack: strategy.handedBack,
      scriptId: strategy.scriptId,
      description: strategy.description,
    }));
    return send(200, {
      loop: {
        ...summary(loop),
        statusReason: null,
        summary: null,
        bestStrategyId: strategies[0]?.id ?? null,
        strategies,
      },
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
    LUXALGO_QUANT_TOOLS: "on",
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

/* Journal tools without a sign-in: every one is protected — reads and writes alike meet the OAuth challenge before anything reaches the app; schemas are on the wire as designed. */

const READ = "journal_list_accounts";
const WRITE = "journal_write_note";
const WRITE_ARGS = { date: "2026-01-01", body: "smoke test — must never be written" };

export async function run({ client, check, httpUrl, rawToolsList }) {
  // Anonymous calls. Hosted: the transport refuses with 401 + WWW-Authenticate
  // before the tool runs. Stdio: the tool answers the in-band challenge. A
  // write tool must behave exactly like a read — a note must never be created
  // on nobody's behalf.
  if (httpUrl) {
    for (const [name, args] of [
      [READ, {}],
      [WRITE, WRITE_ARGS],
    ]) {
      const response = await fetch(httpUrl, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      const challenge = response.headers.get("www-authenticate") ?? "";
      check(
        `hosted ${name} without a token is refused at the transport (401 + WWW-Authenticate)`,
        response.status === 401 &&
          /^Bearer error="invalid_token", /.test(challenge) &&
          /resource_metadata="https?:\/\/[^"]+\/\.well-known\/oauth-protected-resource/.test(challenge),
        `${response.status} ${challenge.slice(0, 120)}`,
      );
    }
  } else {
    for (const [name, args] of [
      [READ, {}],
      [WRITE, WRITE_ARGS],
    ]) {
      const result = await client.callTool({ name, arguments: args });
      const challenge = result._meta?.["mcp/www_authenticate"]?.[0] ?? "";
      check(
        `stdio ${name} without a sign-in answers the in-band OAuth challenge`,
        result.isError === true &&
          /^Bearer .*resource_metadata="https?:\/\/[^"]+\/\.well-known\/oauth-protected-resource/.test(challenge) &&
          /npx -y @luxalgo\/mcp login/.test(result.content?.[0]?.text ?? ""),
        challenge.slice(0, 100) || (result.content?.[0]?.text ?? "").slice(0, 100),
      );
    }
  }

  // Input schemas on the wire — the shapes an AI client sees.
  const tools = await rawToolsList();
  const schemaOf = (name) => tools.find((t) => t.name === name)?.inputSchema ?? {};
  const props = (name) => Object.keys(schemaOf(name).properties ?? {});

  check(
    "journal_update_trade exposes replace and adjust forms for tags and mistakes",
    ["key", "notes", "tags", "addTags", "removeTags", "mistakes", "addMistakes", "removeMistakes", "playbookId", "rating", "stopLoss", "profitTarget", "reviewed"].every(
      (p) => props("journal_update_trade").includes(p),
    ) && (schemaOf("journal_update_trade").required ?? []).join() === "key",
    props("journal_update_trade").join(", "),
  );
  const fills = schemaOf("journal_add_trade").properties?.fills;
  check(
    "journal_add_trade requires accountId and 1–100 fills with symbol/side/quantity/price/executedAt",
    (schemaOf("journal_add_trade").required ?? []).slice().sort().join() === "accountId,fills" &&
      fills?.type === "array" &&
      fills.minItems === 1 &&
      fills.maxItems === 100 &&
      ["symbol", "side", "quantity", "price", "executedAt"].every((p) => (fills.items?.required ?? []).includes(p)),
    JSON.stringify(fills?.items?.required),
  );
  check(
    "journal_overview / journal_breakdown take range, from, to and accounts",
    ["journal_overview", "journal_breakdown"].every((name) => ["range", "from", "to", "accounts"].every((p) => props(name).includes(p))) &&
      props("journal_overview").includes("compare"),
    `${props("journal_overview").join(", ")} | ${props("journal_breakdown").join(", ")}`,
  );
  check(
    "journal_list_trades and journal_search_notes are cursor-paginated",
    ["journal_list_trades", "journal_search_notes"].every((name) => props(name).includes("cursor") && props(name).includes("limit")),
    `${props("journal_list_trades").join(", ")} | ${props("journal_search_notes").join(", ")}`,
  );
  const sort = schemaOf("journal_list_trades").properties?.sort;
  const order = schemaOf("journal_list_trades").properties?.order;
  check(
    "journal_list_trades sorts by the eight summary fields the app orders on, asc or desc",
    JSON.stringify(sort?.enum) === JSON.stringify(["openedAt", "closedAt", "netPnl", "grossPnl", "durationMs", "quantity", "symbol", "rating"]) &&
      JSON.stringify(order?.enum) === JSON.stringify(["asc", "desc"]),
    `sort=${JSON.stringify(sort?.enum)} order=${JSON.stringify(order?.enum)}`,
  );
  check(
    "journal_calendar's month and journal_get_day's date are optional/required as designed",
    !(schemaOf("journal_calendar").required ?? []).includes("month") && (schemaOf("journal_get_day").required ?? []).includes("date"),
    `calendar.required=${JSON.stringify(schemaOf("journal_calendar").required)} day.required=${JSON.stringify(schemaOf("journal_get_day").required)}`,
  );

  // Every journal tool is protected, so each carries the auto-appended sign-in sentence.
  const journalTools = tools.filter((t) => t.name.startsWith("journal_"));
  check(
    `all ${journalTools.length} journal tools say they require a LuxAlgo sign-in`,
    journalTools.length === 13 && journalTools.every((t) => /Requires signing in with a LuxAlgo account/.test(t.description ?? "")),
    journalTools.filter((t) => !/Requires signing in/.test(t.description ?? "")).map((t) => t.name).join(", ") || "all",
  );
}

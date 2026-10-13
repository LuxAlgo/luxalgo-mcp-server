/* Quant tools without a sign-in: both are protected, so a generation (which spends plan usage) and a check alike meet the OAuth challenge before anything reaches the app; schemas, annotations and copy are on the wire as designed. Never calls the app's Quant routes. */

const CALLS = [
  ["quant_generate_pine", { prompt: "smoke test — must never be generated" }],
  ["quant_validate_pine", { code: '//@version=6\nindicator("smoke")\nplot(close)' }],
];

export async function run({ client, check, httpUrl, rawToolsList }) {
  // Anonymous calls. Hosted: the transport refuses with 401 + WWW-Authenticate
  // before the tool runs. Stdio: the tool answers the in-band challenge. A
  // generation must never run, or spend usage, on nobody's behalf.
  if (httpUrl) {
    for (const [name, args] of CALLS) {
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
    for (const [name, args] of CALLS) {
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

  // Input schemas, annotations and descriptions on the wire — what an AI client sees.
  const tools = await rawToolsList();
  const tool = (name) => tools.find((t) => t.name === name) ?? {};
  const schemaOf = (name) => tool(name).inputSchema ?? {};
  const props = (name) => Object.keys(schemaOf(name).properties ?? {});
  const required = (name) => schemaOf(name).required ?? [];

  check(
    "quant_generate_pine takes a required prompt and an optional script to change, with no model choice",
    props("quant_generate_pine").includes("prompt") &&
      props("quant_generate_pine").includes("code") &&
      !props("quant_generate_pine").includes("model") &&
      required("quant_generate_pine").includes("prompt") &&
      !required("quant_generate_pine").includes("code") &&
      !/quant-max/.test(tool("quant_generate_pine").description ?? ""),
    `${props("quant_generate_pine").join(", ")} | required ${JSON.stringify(required("quant_generate_pine"))}`,
  );
  check(
    "quant_validate_pine takes the code to check",
    props("quant_validate_pine").includes("code") && required("quant_validate_pine").includes("code"),
    `${props("quant_validate_pine").join(", ")} | required ${JSON.stringify(required("quant_validate_pine"))}`,
  );
  check(
    "writing a script is marked as not read-only (it spends plan usage); checking one is read-only",
    tool("quant_generate_pine").annotations?.readOnlyHint === false &&
      tool("quant_generate_pine").annotations?.destructiveHint === false &&
      tool("quant_validate_pine").annotations?.readOnlyHint === true,
    `generate ${JSON.stringify(tool("quant_generate_pine").annotations)} | validate ${JSON.stringify(tool("quant_validate_pine").annotations)}`,
  );

  // Copy: Pine Script® keeps its ®, Quant is never "Quant AI", and both say they need a sign-in.
  const quantTools = tools.filter((t) => t.name.startsWith("quant_"));
  const copyOk = (t) =>
    /Requires signing in with a LuxAlgo account/.test(t.description ?? "") &&
    /Pine Script®/.test(t.description ?? "") &&
    !/Pine Script(?!®)/.test(JSON.stringify(t)) &&
    !/Quant AI/i.test(JSON.stringify(t));
  check(
    `both Quant tools say they require a LuxAlgo sign-in and follow the copy guide (Pine Script®, never "Quant AI")`,
    quantTools.length === 2 && quantTools.every(copyOk),
    quantTools.filter((t) => !copyOk(t)).map((t) => t.name).join(", ") || `${quantTools.length} tools`,
  );
}

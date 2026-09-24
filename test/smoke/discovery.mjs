/*
  OAuth discovery on both hosts (HTTP only). The standard host must look
  like any RFC 9728 server — ChatGPT's app submission rejects it otherwise.
  The Claude host must look authless until a protected tool is called — the
  claude-ai-mcp#1013 workaround — and still lead a refused client to sign-in.

  The Claude host is the standard one with `claude.` in front. Against a
  deployment it is requested directly; against localhost (no DNS for
  claude.localhost everywhere) the request goes to the same process with
  X-Forwarded-Host set, which is how the server tells the hosts apart behind
  a proxy anyway.
*/

export async function run({ check, httpUrl }) {
  const standard = new URL(httpUrl);
  const claude = new URL(httpUrl);
  claude.hostname = `claude.${claude.hostname}`;
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(standard.hostname);

  const fetchOn = (host, path, init = {}) => {
    const base = host === "claude" && !local ? claude : standard;
    const headers = { ...init.headers, ...(host === "claude" && local ? { "x-forwarded-host": claude.host } : {}) };
    return fetch(new URL(path, base), { ...init, headers });
  };
  const status = async (host, path) => (await fetchOn(host, path)).status;
  const wellKnown = `/.well-known/oauth-protected-resource${standard.pathname.replace(/\/+$/, "")}`;

  const callProtected = (host) =>
    fetchOn(host, standard.pathname, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "luxalgo_account", arguments: {} } }),
    });
  const resourceMetadataOf = (response) =>
    /resource_metadata="([^"]+)"/.exec(response.headers.get("www-authenticate") ?? "")?.[1] ?? "";

  // Standard host: plain RFC 9728.
  const prm = await fetchOn("standard", wellKnown);
  const prmBody = prm.ok ? await prm.json() : {};
  check(
    "standard host publishes its OAuth metadata at the well-known address",
    prm.status === 200 && prmBody.resource === standard.href && prmBody.authorization_servers?.length === 1,
    `${prm.status} resource=${prmBody.resource}`,
  );
  check(
    "standard host also publishes it at the root well-known address",
    (await status("standard", "/.well-known/oauth-protected-resource")) === 200,
  );
  check("standard host has nothing at the Claude-only metadata address", (await status("standard", "/auth/prm")) === 404);
  const standardChallenge = await callProtected("standard");
  check(
    "standard host's sign-in challenge points at its well-known metadata",
    standardChallenge.status === 401 && resourceMetadataOf(standardChallenge) === new URL(wellKnown, standard).href,
    `${standardChallenge.status} ${resourceMetadataOf(standardChallenge)}`,
  );

  // Claude host: nothing discoverable until a protected tool is called.
  check(
    "Claude host hides OAuth metadata from both well-known addresses",
    (await status("claude", wellKnown)) === 404 && (await status("claude", "/.well-known/oauth-protected-resource")) === 404,
  );
  const claudeChallenge = await callProtected("claude");
  const pointer = resourceMetadataOf(claudeChallenge);
  check(
    "Claude host's sign-in challenge points at its own metadata address",
    claudeChallenge.status === 401 && pointer === new URL("/auth/prm", claude).href,
    `${claudeChallenge.status} ${pointer}`,
  );
  const claudePrm = await fetchOn("claude", "/auth/prm");
  const claudePrmBody = claudePrm.ok ? await claudePrm.json() : {};
  check(
    "Claude host's metadata names the Claude address as the resource to sign in for",
    claudePrm.status === 200 && claudePrmBody.resource === claude.href,
    `${claudePrm.status} resource=${claudePrmBody.resource}`,
  );

  const listed = await fetchOn("claude", standard.pathname, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  const text = await listed.text();
  const tools = JSON.parse(text.startsWith("{") ? text : (text.match(/^data: (.*)$/m)?.[1] ?? "{}")).result?.tools ?? [];
  check(
    "Claude host lists every tool without per-tool sign-in hints",
    tools.length > 0 && tools.every((t) => !("securitySchemes" in t)),
    `${tools.length} tools; with field: ${tools.filter((t) => "securitySchemes" in t).length}`,
  );

  // A refused token on the Claude host is sent to the Claude host's sign-in, not the standard one.
  const forged = await fetchOn("claude", standard.pathname, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer not-a-jwt" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  check(
    "an invalid token on the Claude host is refused with the Claude host's challenge",
    forged.status === 401 && resourceMetadataOf(forged) === new URL("/auth/prm", claude).href,
    `${forged.status} ${resourceMetadataOf(forged)}`,
  );
}

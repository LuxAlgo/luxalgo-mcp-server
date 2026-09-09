/* luxalgo_account without a sign-in: 401 challenge at the transport when hosted, in-band _meta challenge on stdio. */

export async function run({ client, check, httpUrl }) {
  // luxalgo_account without a sign-in. Hosted: the transport refuses with 401 +
  // WWW-Authenticate before the tool runs (the client SDK surfaces that as an
  // UnauthorizedError because this smoke client has no OAuth provider). Stdio:
  // there is no transport status, so the tool itself answers the in-band
  // challenge — isError with _meta["mcp/www_authenticate"] and the login hint.
  if (httpUrl) {
    // Raw fetch: the SDK client hides the status. Anthropic's lazy-auth recipe
    // is exact about this response — HTTP 401 with
    // `WWW-Authenticate: Bearer error="invalid_token", …, resource_metadata="…", scope="…"`.
    const response = await fetch(httpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "luxalgo_account", arguments: {} } }),
    });
    const challenge = response.headers.get("www-authenticate") ?? "";
    check(
      "hosted luxalgo_account without a token is refused at the transport (401 + WWW-Authenticate)",
      response.status === 401 &&
        /^Bearer error="invalid_token", /.test(challenge) &&
        /resource_metadata="https?:\/\/[^"]+\/\.well-known\/oauth-protected-resource/.test(challenge) &&
        /scope="openid /.test(challenge),
      `${response.status} ${challenge.slice(0, 120)}`,
    );
  } else {
    const account = await client.callTool({ name: "luxalgo_account", arguments: {} });
    const challenge = account._meta?.["mcp/www_authenticate"]?.[0] ?? "";
    check(
      "stdio luxalgo_account without a sign-in answers the in-band OAuth challenge",
      account.isError === true &&
        /^Bearer .*resource_metadata="https?:\/\/[^"]+\/\.well-known\/oauth-protected-resource/.test(challenge) &&
        /npx -y @luxalgo\/mcp login/.test(account.content?.[0]?.text ?? ""),
      challenge.slice(0, 100) || (account.content?.[0]?.text ?? "").slice(0, 100),
    );
  }
}

/* luxalgo_account without a sign-in: 401 challenge at the transport when hosted, in-band _meta challenge on stdio. */

export async function run({ client, check, httpUrl }) {
  // luxalgo_account without a sign-in. Hosted: the transport refuses with 401 +
  // WWW-Authenticate before the tool runs (the client SDK surfaces that as an
  // UnauthorizedError because this smoke client has no OAuth provider). Stdio:
  // there is no transport status, so the tool itself answers the in-band
  // challenge — isError with _meta["mcp/www_authenticate"] and the login hint.
  if (httpUrl) {
    let thrown;
    try {
      await client.callTool({ name: "luxalgo_account", arguments: {} });
    } catch (error) {
      thrown = error;
    }
    check(
      "hosted luxalgo_account without a token is refused at the transport (401 challenge)",
      thrown !== undefined && /401|unauthorized/i.test(String(thrown?.message ?? thrown)),
      String(thrown?.message ?? thrown ?? "no error").slice(0, 120),
    );
  } else {
    const account = await client.callTool({ name: "luxalgo_account", arguments: {} });
    const challenge = account._meta?.["mcp/www_authenticate"]?.[0] ?? "";
    check(
      "stdio luxalgo_account without a sign-in answers the in-band OAuth challenge",
      account.isError === true &&
        /^Bearer resource_metadata="https?:\/\/[^"]+\/\.well-known\/oauth-protected-resource/.test(challenge) &&
        /npx -y @luxalgo\/mcp login/.test(account.content?.[0]?.text ?? ""),
      challenge.slice(0, 100) || (account.content?.[0]?.text ?? "").slice(0, 100),
    );
  }
}

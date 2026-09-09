/*
  Local (stdio) entry — what `npx @luxalgo/mcp` runs. Serves every module in
  server/manifest.ts, local-only ones included: the broker tools read the
  user's own keys from BROKERS_* env vars in their MCP client config, and
  those keys never leave this machine.

  LuxAlgo account (OAuth): protected tools such as luxalgo_account need a
  signed-in user. Locally this process is itself the OAuth client — run
  `npx -y @luxalgo/mcp login` once (browser sign-in with LuxAlgo, tokens
  stored under the user's config dir) or, with an MCP client that supports
  URL elicitation, sign in when the tool first asks. See auth/local/.

  Subcommands: `login`, `logout`, `status` (auth/local/cli.ts). With no
  subcommand the process is an MCP stdio server.
*/
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { registerLuxalgoTools } from "../server/create-server.js";
import { SERVER_NAME, SERVER_VERSION } from "../server/version.js";
import { connectionsFromEnv } from "../tools/broker/tools.js";
import { shutdownAnalytics } from "../platform/analytics.js";
import { createLocalAuthRuntime } from "../auth/local/runtime.js";
import { isAuthCommand, runAuthCommand } from "../auth/local/cli.js";
import { readStoredAuth } from "../auth/local/store.js";
import { AUTH_ISSUER, MCP_RESOURCE } from "../auth/config.js";

// stderr only — stdout belongs to the MCP protocol.
const log = (message: string) => console.error(`luxalgo-mcp: ${message}`);

export function main(argv: string[] = process.argv.slice(2)): void {
  const [command, ...commandArgs] = argv;
  if (isAuthCommand(command)) {
    runAuthCommand(command, commandArgs).then(
      (code) => process.exit(code),
      (error) => {
        console.error(`luxalgo-mcp ${command} failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
      },
    );
    return;
  }
  serve();
}

function serve(): void {
  const configured = connectionsFromEnv(process.env).map((c) => c.broker);
  log(
    configured.length > 0
      ? `broker tools serving ${configured.length} connection(s): ${configured.join(", ")} (read-only)`
      : "no broker configured (keyless tools only) — call broker_setup to see the env vars",
  );
  // Read-only peek (no refresh here — that happens lazily on the first
  // protected call, so startup never races a tool call for the refresh token).
  void readStoredAuth({ issuer: AUTH_ISSUER, resource: MCP_RESOURCE }).then(
    (stored) =>
      log(
        stored?.tokens
          ? "LuxAlgo account signed in — protected tools available"
          : "not signed in to LuxAlgo — protected tools will ask you to run `npx -y @luxalgo/mcp login`",
      ),
    () => {},
  );

  // Flush queued analytics events before the process dies. Only installed when
  // analytics is on, so default signal behavior is untouched otherwise.
  if (process.env.POSTHOG_PROJECT_TOKEN) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => {
        void shutdownAnalytics().finally(() => process.exit(0));
      });
    }
  }

  // serveStdio() calls the factory once per connection (MCP 2026-07-28 pins
  // one instance for the connection's lifetime and also serves 2025-era
  // clients from the same factory). The auth runtime holds the server so it
  // can ask the client to open the sign-in URL (URL-mode elicitation).
  serveStdio(() => {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    registerLuxalgoTools(server, { entry: "local", auth: createLocalAuthRuntime(server, log), log });
    return server;
  });
}

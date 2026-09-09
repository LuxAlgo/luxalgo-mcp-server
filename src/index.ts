#!/usr/bin/env node
/*
  Local (stdio) entry — what `npx @luxalgo/mcp` runs. Serves every shared
  (keyless, hosted-safe) tool from register.ts, plus the broker tools:
  read-only portfolio access via @luxalgo/broker-sdk, using the user's own
  broker keys from BROKERS_* env vars in their MCP client config. Broker
  tools are LOCAL ONLY, on purpose — keys never leave this machine, so the
  hosted entries never register them.

  LuxAlgo account (OAuth): protected tools such as luxalgo_account need a
  signed-in user. Locally this process is itself the OAuth client — run
  `npx -y @luxalgo/mcp login` once (browser sign-in with LuxAlgo, tokens
  stored under the user's config dir) or, with an MCP client that supports
  URL elicitation, sign in when the tool first asks. See lib/auth/local/.

  Subcommands: `login`, `logout`, `status` (lib/auth/local/cli.ts). With no
  subcommand the process is an MCP stdio server.
*/
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { SERVER_NAME, SERVER_VERSION, registerAllTools } from "./lib/register.js";
import { connectionsFromEnv, registerBrokerTools } from "./lib/broker-tools.js";
import { instrumentServer, shutdownAnalytics } from "./lib/analytics.js";
import { createLocalAuthRuntime } from "./lib/auth/local/runtime.js";
import { isAuthCommand, runAuthCommand } from "./lib/auth/local/cli.js";
import { readStoredAuth } from "./lib/auth/local/store.js";
import { AUTH_ISSUER, MCP_RESOURCE } from "./lib/auth/config.js";

const [command, ...commandArgs] = process.argv.slice(2);
if (isAuthCommand(command)) {
  runAuthCommand(command, commandArgs).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`luxalgo-mcp ${command} failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
} else {
  serve();
}

function serve() {
  /** One fully registered server. serveStdio() calls this once per connection
   *  (MCP 2026-07-28 pins one instance for the connection's lifetime and also
   *  serves 2025-era clients from the same factory). */
  const createServer = (): McpServer => {
    const server = new McpServer({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });

    // Instrument before registering so every tool is wrapped. No-op unless
    // POSTHOG_PROJECT_TOKEN is set; the logger writes to stderr (stdout is MCP's).
    instrumentServer(server, (message) => console.error(`[posthog] ${message}`));

    registerAllTools(server, {
      auth: createLocalAuthRuntime(server, (message) => console.error(`luxalgo-mcp: ${message}`)),
      also: (s) => registerBrokerTools(s), // stdio only — never move into registerAllTools
    });
    return server;
  };

  // stderr only — stdout belongs to the MCP protocol.
  const configured = connectionsFromEnv(process.env).map((c) => c.broker);
  console.error(
    configured.length > 0
      ? `luxalgo-mcp: broker tools serving ${configured.length} connection(s): ${configured.join(", ")} (read-only)`
      : "luxalgo-mcp: no broker configured (keyless tools only) — call broker_setup to see the env vars",
  );
  // Read-only peek (no refresh here — that happens lazily on the first
  // protected call, so startup never races a tool call for the refresh token).
  void readStoredAuth({ issuer: AUTH_ISSUER, resource: MCP_RESOURCE }).then(
    (stored) =>
      console.error(
        stored?.tokens
          ? "luxalgo-mcp: LuxAlgo account signed in — protected tools available"
          : "luxalgo-mcp: not signed in to LuxAlgo — protected tools will ask you to run `npx -y @luxalgo/mcp login`",
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

  serveStdio(() => createServer());
}

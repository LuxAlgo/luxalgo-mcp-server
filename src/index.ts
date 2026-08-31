#!/usr/bin/env node
/*
  Local (stdio) entry — what `npx @luxalgo/mcp` runs. Serves every shared
  (keyless, hosted-safe) tool from register.ts, plus the broker tools:
  read-only portfolio access via @luxalgo/broker-sdk, using the user's own
  broker keys from BROKERS_* env vars in their MCP client config. Broker
  tools are LOCAL ONLY, on purpose — keys never leave this machine, so the
  hosted entries never register them.
*/
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SERVER_NAME, SERVER_VERSION, registerAllTools } from "./lib/register.js";
import { connectionsFromEnv, registerBrokerTools } from "./lib/broker-tools.js";
import { instrumentServer, shutdownAnalytics } from "./lib/analytics.js";

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

// Instrument before registering so every tool is wrapped. No-op unless
// POSTHOG_PROJECT_TOKEN is set; the logger writes to stderr (stdout is MCP's).
instrumentServer(server, (message) => console.error(`[posthog] ${message}`));

registerAllTools(server);
registerBrokerTools(server); // stdio only — never move into registerAllTools

// stderr only — stdout belongs to the MCP protocol.
const configured = connectionsFromEnv(process.env).map((c) => c.broker);
console.error(
  configured.length > 0
    ? `luxalgo-mcp: broker tools serving ${configured.length} connection(s): ${configured.join(", ")} (read-only)`
    : "luxalgo-mcp: no broker configured (keyless tools only) — call broker_setup to see the env vars",
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

const transport = new StdioServerTransport();
await server.connect(transport);

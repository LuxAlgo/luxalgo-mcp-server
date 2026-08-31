/*
  PostHog MCP Analytics (https://posthog.com/docs/mcp-analytics), shared by
  every entry point. Wraps a server with @posthog/mcp's instrument(), which
  auto-captures $mcp_tool_call, $mcp_initialize, $mcp_tools_list, and
  $exception events.

  Entirely opt-in: analytics only activate when POSTHOG_PROJECT_TOKEN is
  set. Nothing is captured otherwise, which keeps local stdio runs (and
  forks of this repo) telemetry-free by default.

  Env vars:
    POSTHOG_PROJECT_TOKEN  phc_… project API key; unset = analytics off
    POSTHOG_HOST           optional, defaults to https://us.i.posthog.com
*/
import { PostHog } from "posthog-node";
import { instrument } from "@posthog/mcp";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

let client: PostHog | undefined;

/** Lazily create the process-wide PostHog client, or undefined when unconfigured. */
export function getPosthog(): PostHog | undefined {
  const token = process.env.POSTHOG_PROJECT_TOKEN;
  if (!token) return undefined;
  client ??= new PostHog(token, {
    host: process.env.POSTHOG_HOST ?? "https://us.i.posthog.com",
  });
  return client;
}

/**
 * Instrument a server with MCP analytics. No-op when POSTHOG_PROJECT_TOKEN
 * is unset. `logger` must be STDIO-safe (stderr, never stdout).
 */
export function instrumentServer(
  server: McpServer,
  logger?: (message: string) => void,
): void {
  const posthog = getPosthog();
  if (!posthog) return;
  instrument(server, posthog, { logger });
}

/** Drain queued events without tearing the client down (serverless-friendly). */
export async function flushAnalytics(): Promise<void> {
  if (client) await client.flush();
}

/** Flush and stop the client; call from SIGTERM/exit handlers. */
export async function shutdownAnalytics(): Promise<void> {
  if (client) await client.shutdown();
}

/*
  How protected tools get the user's token on the local (stdio) server.
  Order of preference when a protected tool is called:

    1. a stored access token that is still valid  → use it
    2. an expired one with a refresh token         → refresh silently, use it
    3. nothing usable, but the MCP client supports URL-mode elicitation
       (MCP 2026-07-28) → run the browser sign-in right now: the client is
       asked to open the authorization URL, we wait for the loopback
       callback, then the tool proceeds with the fresh token
    4. otherwise → the tool answers the sign-in challenge with a hint to run
       `npx -y @luxalgo/mcp login` (the CLI flow in login.ts)

  Public tools get steps 1–2 only (`peekAccess`): whatever is at hand is
  forwarded to the app so it can personalise, but nobody is ever prompted to
  sign in for a tool that works anonymously.

  The token is only ever sent to the LuxAlgo app (the tool calls its API
  with it); the MCP client on this machine never sees it.
*/
import { randomUUID } from "node:crypto";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { Access, AuthRuntime } from "../protected-tools.js";
import { AUTH_ISSUER, MCP_RESOURCE } from "../config.js";
import { peekClaims, refreshQuietly, signIn } from "./login.js";
import { readStoredAuth, secondsUntilExpiry, type StoredAuth } from "./store.js";

export const LOCAL_SIGN_IN_HINT = "From this machine, run `npx -y @luxalgo/mcp login` and try again.";

/** Refresh when this close to expiry, so a token never dies mid-request. */
const REFRESH_MARGIN_SECONDS = 60;

export function createLocalAuthRuntime(server: McpServer, log: (message: string) => void = () => {}): AuthRuntime {
  return {
    signInHint: LOCAL_SIGN_IN_HINT,
    peekAccess: async () => {
      const stored = await usableTokens();
      return stored ? toAccess(stored) : undefined;
    },
    resolveAccess: async (ctx) => {
      const stored = await usableTokens();
      if (stored) return toAccess(stored);

      if (!clientSupportsUrlElicitation(server)) return undefined;
      try {
        log("no valid sign-in on this machine — asking the client to open the LuxAlgo sign-in page");
        await signIn({ present: (url) => presentViaElicitation(ctx, url) });
      } catch (error) {
        log(`in-session sign-in did not complete: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
      const fresh = await usableTokens();
      return fresh ? toAccess(fresh) : undefined;
    },
  };
}

/** Stored tokens that are valid now, refreshing first if they are (about to be) expired. */
export async function usableTokens(): Promise<NonNullable<StoredAuth["tokens"]> | undefined> {
  const read = async () => (await readStoredAuth({ issuer: AUTH_ISSUER, resource: MCP_RESOURCE }))?.tokens;
  const tokens = await read();
  if (!tokens) return undefined;
  const remaining = secondsUntilExpiry(tokens);
  if (remaining === undefined || remaining > REFRESH_MARGIN_SECONDS) return tokens;
  if (!tokens.refresh_token) return undefined;
  return (await refreshQuietly()) ? read() : undefined;
}

function toAccess(tokens: NonNullable<StoredAuth["tokens"]>): Access {
  const { sub, email } = peekClaims(tokens);
  return { token: tokens.access_token, ...(sub ? { userId: sub } : {}), ...(email ? { email } : {}) };
}

function clientSupportsUrlElicitation(server: McpServer): boolean {
  const capabilities = server.server.getClientCapabilities() as { elicitation?: { url?: unknown } } | undefined;
  return capabilities?.elicitation?.url !== undefined;
}

async function presentViaElicitation(ctx: ServerContext, url: URL): Promise<void> {
  const result = await ctx.mcpReq.elicitInput({
    mode: "url",
    elicitationId: randomUUID(),
    message: "Sign in with your LuxAlgo account to use this tool. Your browser will open the LuxAlgo sign-in page; this tool continues once you approve.",
    url: url.toString(),
  });
  if (result.action !== "accept") {
    throw new Error(`user ${result.action === "decline" ? "declined" : "cancelled"} the sign-in`);
  }
}

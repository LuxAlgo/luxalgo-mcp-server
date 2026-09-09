/*
  `npx -y @luxalgo/mcp <command>` — account commands for the local install.
  Everything prints to stderr except values a script might want (stdout),
  so the same binary stays safe to run as an MCP stdio server otherwise.

    login    open the browser, sign in with LuxAlgo, store tokens locally
    logout   forget the stored sign-in
    status   who is signed in on this machine, and for how long
*/
import { AUTH_ISSUER, MCP_RESOURCE } from "../config.js";
import { openInBrowser, peekClaims, signIn } from "./login.js";
import { authFilePath, clearStoredAuth, readStoredAuth, secondsUntilExpiry } from "./store.js";
import { usableTokens } from "./runtime.js";

export const AUTH_COMMANDS = ["login", "logout", "status"] as const;
export type AuthCommand = (typeof AUTH_COMMANDS)[number];

export function isAuthCommand(value: string | undefined): value is AuthCommand {
  return (AUTH_COMMANDS as readonly string[]).includes(value ?? "");
}

export async function runAuthCommand(command: AuthCommand, args: string[]): Promise<number> {
  const say = (message: string) => console.error(message);
  switch (command) {
    case "login": {
      const force = args.includes("--force");
      say(`Signing in to LuxAlgo (${new URL(AUTH_ISSUER).origin}) for ${MCP_RESOURCE} …`);
      const outcome = await signIn({
        force,
        present: (url) => {
          say("\nOpen this link if your browser did not open automatically:\n\n  " + url.toString() + "\n");
          openInBrowser(url);
        },
      });
      const tokens = (await readStoredAuth({ issuer: AUTH_ISSUER, resource: MCP_RESOURCE }))?.tokens;
      const who = peekClaims(tokens).email;
      say(
        outcome.kind === "refreshed"
          ? `Already signed in${who ? ` as ${who}` : ""} (session refreshed). Use --force to sign in as someone else.`
          : `Signed in${who ? ` as ${who}` : ""}. Tokens stored in ${authFilePath()}`,
      );
      say("Protected LuxAlgo tools (e.g. luxalgo_account) now work in your MCP client.");
      return 0;
    }
    case "logout": {
      const removed = await clearStoredAuth();
      say(removed ? `Signed out — removed ${authFilePath()}` : "Nothing to sign out of (no stored sign-in).");
      return 0;
    }
    case "status": {
      const stored = await readStoredAuth({ issuer: AUTH_ISSUER, resource: MCP_RESOURCE });
      if (!stored?.tokens) {
        say(`Not signed in. Run: npx -y @luxalgo/mcp login   (store: ${authFilePath()})`);
        return 1;
      }
      const claims = peekClaims(stored.tokens);
      const remaining = secondsUntilExpiry(stored.tokens);
      const state =
        remaining === undefined ? "expiry unknown" : remaining > 0 ? `expires in ${formatDuration(remaining)}` : "expired";
      say(`Signed in${claims.email ? ` as ${claims.email}` : ""} (user ${claims.sub ?? "?"}) — access token ${state}${stored.tokens.refresh_token ? ", refresh token present" : ", no refresh token"}`);
      say(`Issuer   ${stored.issuer}\nResource ${stored.resource}\nStore    ${authFilePath()}`);
      if (remaining !== undefined && remaining <= 0 && stored.tokens.refresh_token) {
        say((await usableTokens()) ? "Refreshed successfully." : "Refresh failed — run `npx -y @luxalgo/mcp login`.");
      }
      return 0;
    }
  }
}

const formatDuration = (seconds: number): string => {
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
};

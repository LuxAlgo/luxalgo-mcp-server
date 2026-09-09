/*
  Where the local (stdio) server keeps the user's OAuth state between runs:
  one JSON file, owner-readable only, under the platform config directory
  (override with LUXALGO_MCP_AUTH_FILE). It holds the tokens the LuxAlgo app
  issued to THIS machine's copy of the server, the client registration (when
  DCR was used instead of CIMD) and cached OAuth discovery. `luxalgo-mcp
  logout` deletes it. Nothing here ever reaches the hosted server.
*/
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthDiscoveryState, StoredOAuthClientInformation, StoredOAuthTokens } from "@modelcontextprotocol/client";

export type StoredAuth = {
  version: 1;
  /** Which app + resource these credentials belong to, so a config change invalidates them. */
  issuer: string;
  resource: string;
  tokens?: StoredOAuthTokens & { obtainedAt: number };
  clientInformation?: StoredOAuthClientInformation;
  discovery?: OAuthDiscoveryState;
};

export function authFilePath(): string {
  const override = process.env.LUXALGO_MCP_AUTH_FILE?.trim();
  if (override) return override;
  const base =
    process.platform === "win32"
      ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
      : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return join(base, "luxalgo", "mcp-auth.json");
}

export async function readStoredAuth(expected: { issuer: string; resource: string }): Promise<StoredAuth | undefined> {
  let raw: string;
  try {
    raw = await readFile(authFilePath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredAuth>;
    if (parsed.version !== 1 || parsed.issuer !== expected.issuer || parsed.resource !== expected.resource) {
      return undefined; // different app/resource (env changed) — start over rather than send tokens to the wrong place
    }
    return parsed as StoredAuth;
  } catch {
    return undefined;
  }
}

export async function writeStoredAuth(auth: StoredAuth): Promise<void> {
  const path = authFilePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(auth, null, 2), { encoding: "utf8", mode: 0o600 });
  // writeFile's mode only applies on creation; make sure an existing file is tightened too.
  if (process.platform !== "win32") await chmod(path, 0o600);
}

export async function clearStoredAuth(): Promise<boolean> {
  try {
    await rm(authFilePath());
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Seconds until the stored access token expires (negative = expired); undefined when unknown. */
export function secondsUntilExpiry(tokens: StoredAuth["tokens"]): number | undefined {
  if (!tokens?.expires_in) return undefined;
  return Math.floor((tokens.obtainedAt + tokens.expires_in * 1000 - Date.now()) / 1000);
}

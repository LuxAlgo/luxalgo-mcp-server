/*
  The local server as an OAuth 2.1 client, for the MCP SDK's `auth()`
  orchestrator. The SDK does discovery (our own RFC 9728 document → the
  app's RFC 8414 metadata), client identification, PKCE, the authorization
  request, code exchange and refresh; this provider supplies what only we
  know — where to persist things and how to get the user into a browser.

  Client identity: a Client ID Metadata Document (our public/oauth/
  client.json, served by the hosted deployment) when the resource is https,
  so no per-machine registration and no client secret — this is a public
  native client (RFC 8252) with a loopback redirect. Against a localhost
  resource the SDK falls back to Dynamic Client Registration, which the app
  also allows.
*/
import { randomBytes } from "node:crypto";
import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { AUTH_ISSUER, CLIENT_METADATA_URL, MCP_RESOURCE, OAUTH_SCOPES } from "../config.js";
import { readStoredAuth, writeStoredAuth, type StoredAuth } from "./store.js";

/** Thrown by a non-interactive provider when the SDK wants to start a browser flow. */
export class SignInRequiredError extends Error {
  constructor() {
    super("No valid LuxAlgo sign-in on this machine");
    this.name = "SignInRequiredError";
  }
}

export type LocalProviderOptions = {
  /** Loopback redirect the flow will come back to; see login.ts. */
  redirectUrl: URL;
  /**
   * Called with the authorization URL the user must open. Omit for
   * refresh-only use: the SDK asking to redirect then means "sign in again".
   */
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
};

export class LocalOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl = CLIENT_METADATA_URL;
  private codeVerifierValue?: string;
  private stateValue?: string;
  private memo?: StoredAuth;

  constructor(private readonly options: LocalProviderOptions) {}

  get redirectUrl(): URL {
    return this.options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "LuxAlgo MCP (local)",
      client_uri: "https://github.com/LuxAlgo/luxalgo-mcp-server",
      redirect_uris: [this.options.redirectUrl.toString()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
      scope: OAUTH_SCOPES.join(" "),
    };
  }

  state(): string {
    this.stateValue = randomBytes(24).toString("base64url");
    return this.stateValue;
  }

  /** The `state` the SDK sent, so the callback can be checked against it. */
  expectedState(): string | undefined {
    return this.stateValue;
  }

  async clientInformation(_ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    return (await this.load()).clientInformation;
  }

  async saveClientInformation(info: StoredOAuthClientInformation): Promise<void> {
    await this.save({ clientInformation: info });
  }

  async tokens(): Promise<StoredOAuthTokens | undefined> {
    return (await this.load()).tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    await this.save({ tokens: { ...tokens, obtainedAt: Date.now() } });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.options.onAuthorizationUrl) throw new SignInRequiredError();
    await this.options.onAuthorizationUrl(url);
  }

  saveCodeVerifier(verifier: string): void {
    this.codeVerifierValue = verifier;
  }

  codeVerifier(): string {
    if (!this.codeVerifierValue) throw new Error("No PKCE verifier for this sign-in attempt");
    return this.codeVerifierValue;
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.load()).discovery;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.save({ discovery: state });
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "verifier") {
      this.codeVerifierValue = undefined;
      return;
    }
    const current = await this.load();
    const next: StoredAuth = { ...current };
    if (scope === "all" || scope === "tokens") delete next.tokens;
    if (scope === "all" || scope === "client") delete next.clientInformation;
    if (scope === "all" || scope === "discovery") delete next.discovery;
    this.memo = next;
    await writeStoredAuth(next);
  }

  private async load(): Promise<StoredAuth> {
    this.memo ??= (await readStoredAuth({ issuer: AUTH_ISSUER, resource: MCP_RESOURCE })) ?? {
      version: 1,
      issuer: AUTH_ISSUER,
      resource: MCP_RESOURCE,
    };
    return this.memo;
  }

  private async save(patch: Partial<StoredAuth>): Promise<void> {
    this.memo = { ...(await this.load()), ...patch };
    await writeStoredAuth(this.memo);
  }
}

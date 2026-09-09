/*
  Access-token verification: the app's better-auth mints JWT access tokens
  signed by its jwt() plugin; we verify them offline against its JWKS —
  signature, issuer, audience, expiry. No database, no call to the app, so
  the check is as cheap on a Vercel function as on a laptop.

  Audience is the whole point: a token minted for one of the app's own MCP
  servers (/api/mcp/private) or anything else the same issuer protects must
  be useless here, and ours must be useless there.
*/
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTPayload } from "jose";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { AUTH_ISSUER, JWKS_URL, MCP_RESOURCE } from "./config.js";

/** Why a presented token was refused — becomes the RFC 6750 `error` code. */
export class TokenError extends Error {
  constructor(
    readonly code: "invalid_token" | "insufficient_scope",
    message: string,
  ) {
    super(message);
    this.name = "TokenError";
  }
}

/** Lazily created so an entry that never sees a token never fetches the JWKS. */
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
const getJwks = () => (jwks ??= createRemoteJWKSet(new URL(JWKS_URL)));

/** What a verified token tells us; `userId` is better-auth's user id (`sub`). */
export type VerifiedToken = AuthInfo & { extra: { userId: string; email?: string } };

export async function verifyAccessToken(token: string): Promise<VerifiedToken> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, getJwks(), {
      issuer: AUTH_ISSUER,
      audience: MCP_RESOURCE,
      clockTolerance: 30,
    }));
  } catch (error) {
    throw new TokenError("invalid_token", describe(error));
  }

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new TokenError("invalid_token", "Token has no subject");
  }
  // A DPoP-bound token (RFC 9449 `cnf`) is only valid together with a proof
  // of possession. This resource advertises no DPoP support, so a compliant
  // client never binds tokens for it; accepting one as a plain bearer would
  // silently downgrade the binding, so refuse instead.
  if (payload.cnf !== undefined) {
    throw new TokenError("invalid_token", "DPoP-bound tokens are not accepted by this resource");
  }

  const scopes = typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [];
  return {
    token,
    clientId: typeof payload.client_id === "string" ? payload.client_id : "",
    scopes,
    expiresAt: payload.exp,
    resource: new URL(MCP_RESOURCE),
    extra: {
      userId: payload.sub,
      ...(typeof payload.email === "string" ? { email: payload.email } : {}),
    },
  };
}

function describe(error: unknown): string {
  if (error instanceof joseErrors.JWTExpired) return "Token has expired";
  if (error instanceof joseErrors.JWTClaimValidationFailed) return `Token claim rejected: ${error.claim}`;
  if (error instanceof joseErrors.JWSSignatureVerificationFailed) return "Token signature is invalid";
  if (error instanceof joseErrors.JWKSNoMatchingKey) return "Token was not signed by a known key";
  if (error instanceof joseErrors.JOSEError) return `Token rejected (${error.code})`;
  return "Token could not be verified";
}

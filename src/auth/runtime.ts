/*
  Where the caller's token comes from — the only thing that differs between
  the entries, injected as an `AuthRuntime`:

    hosted (Vercel / plain Node)  the gate verified the client's bearer and
                                  the SDK exposes it as ctx.http.authInfo
    local (stdio)                 the server IS the OAuth client — the token
                                  comes from the local store filled by
                                  `luxalgo-mcp login` (see local/runtime.ts)

  Tool implementations are identical in both cases: they read the ambient
  Access (access-context.ts) and forward it to the app.
*/
import type { ServerContext } from "@modelcontextprotocol/server";
import type { Access } from "./access-context.js";

export type { Access } from "./access-context.js";

export type AccessResolver = (ctx: ServerContext) => Promise<Access | undefined>;

export type AuthRuntime = {
  /**
   * The token for a protected tool call. May do work to get one (refresh,
   * or on stdio an in-session browser sign-in); undefined means the tool
   * answers the sign-in challenge.
   */
  resolveAccess: AccessResolver;
  /**
   * The token already at hand, without prompting anyone — what public tools
   * forward opportunistically. Defaults to resolveAccess (fine when that is
   * non-interactive, as it is when hosted).
   */
  peekAccess?: AccessResolver;
  /** Appended to the sign-in message — how to authenticate from this entry. */
  signInHint?: string;
};

/** Hosted entries: the gate verified the bearer; the SDK carries it in ctx. */
export const hostedAuthRuntime: AuthRuntime = {
  resolveAccess: async (ctx) => {
    const info = ctx.http?.authInfo;
    if (!info?.token) return undefined;
    const extra = (info.extra ?? {}) as { userId?: unknown; email?: unknown };
    return {
      token: info.token,
      ...(typeof extra.userId === "string" ? { userId: extra.userId } : {}),
      ...(typeof extra.email === "string" ? { email: extra.email } : {}),
    };
  },
};

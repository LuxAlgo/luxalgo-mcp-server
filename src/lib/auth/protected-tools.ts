/*
  Protected tools — the ones that need a signed-in LuxAlgo user. Everything
  else on this server works anonymously; a protected tool is one whose
  handler receives an `Access` (the user's OAuth access token + identity) and
  is refused with a sign-in challenge when there is none.

  This server never checks entitlements itself (its code is public; see
  access-context.ts). Tools forward the token to the app and translate its
  answers: 401 → sign-in challenge, 403 → "your plan does not allow this".
  Whether a tool is "protected" only changes the UX — the challenge comes
  before a pointless round-trip, and clients learn from tools/list which
  tools unlock after linking. Security does not depend on the list.

  Where the token comes from is the only thing that differs between the
  entries, so it is injected as an `AuthRuntime`:
    hosted (Vercel / plain Node)  the gate verified the client's bearer and
                                  the SDK exposes it as ctx.http.authInfo
    local (stdio)                 the server IS the OAuth client — the token
                                  comes from the local store filled by
                                  `luxalgo-mcp login` (see local/)
  The tool implementation is identical in both cases.

  Two client-facing signals derive from the registry kept here:
    • the HTTP gate consults isProtectedTool() to decide which anonymous
      tools/call to refuse with a 401;
    • tools/list carries a per-tool `securitySchemes` array (OpenAI's MCP
      extension — `noauth` for public tools, `oauth2` + scopes for protected
      ones) so ChatGPT knows which tools unlock after linking. Clients that do
      not know the field ignore it.
*/
import type {
  Icon,
  McpServer,
  ServerContext,
  StandardSchemaWithJSON,
  ToolAnnotations,
  ToolCallback,
} from "@modelcontextprotocol/server";
import { AppAuthError, AppPermissionError } from "../api.js";
import { OAUTH_SCOPES } from "./config.js";
import { signInRequiredResult } from "./challenge.js";
import { currentAccess, runWithAccess, type Access } from "./access-context.js";

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

/**
 * Turns the app's refusals into tool results. Any tool calling the app can
 * hit these (a public tool forwarding a stale token to a route where the
 * user is optional cannot — the app then just answers anonymously — but a
 * protected one can), so the mapping lives here and is applied to every
 * tool by instrumentToolRegistration.
 */
export function appErrorResult(error: unknown, signInHint?: string) {
  if (error instanceof AppAuthError) {
    return signInRequiredResult(
      { error: "invalid_token", description: "Your LuxAlgo sign-in is missing or no longer valid. Sign in again." },
      signInHint,
    );
  }
  if (error instanceof AppPermissionError) {
    const which = error.permission ? ` (${error.permission})` : "";
    return {
      isError: true as const,
      content: [
        {
          type: "text" as const,
          text: `Your LuxAlgo plan does not include this${which}: ${error.message}. Upgrading at https://app.luxalgo.com/account/plan unlocks it.`,
        },
      ],
    };
  }
  return undefined;
}

/**
 * Makes every tool registered on `server` from now on run with (a) the
 * caller's token ambient for the whole call — appGet forwards it on every
 * app request, public tools included — and (b) the app's 401/403 turned into
 * proper tool results instead of the SDK's generic "Error: …" text. Call once
 * per server instance, before any registerTool. The SDK converts thrown
 * errors inside its tools/call handler, so this has to wrap the callbacks
 * themselves rather than the request handler.
 */
export function instrumentToolRegistration(server: McpServer, runtime: AuthRuntime): void {
  const peek = runtime.peekAccess ?? runtime.resolveAccess;
  type AnyCallback = (...callArgs: unknown[]) => unknown;
  const register = server.registerTool.bind(server) as (name: string, config: unknown, cb: AnyCallback) => unknown;

  const instrumented: AnyCallback = (name, config, cb) =>
    register(name as string, config, async (...callArgs) => {
      // The SDK calls (args, ctx) for tools with an inputSchema and (ctx) otherwise.
      const ctx = callArgs[callArgs.length - 1] as ServerContext;
      const access = await peek(ctx).catch(() => undefined);
      return runWithAccess(access, async () => {
        try {
          return await (cb as AnyCallback)(...callArgs);
        } catch (error) {
          const mapped = appErrorResult(error, runtime.signInHint);
          if (mapped) return mapped;
          throw error;
        }
      });
    });
  (server as unknown as { registerTool: AnyCallback }).registerTool = instrumented;
}

/**
 * Every protected tool, by name. Static on purpose: the HTTP gate consults
 * this before any McpServer exists for the request (hosted entries build the
 * server per request), so it cannot be filled at registration time or a
 * cold process would wave the first protected call through to the tool.
 * registerProtectedTool refuses names missing from here — add them first.
 */
export const PROTECTED_TOOL_NAMES: ReadonlySet<string> = new Set(["luxalgo_account"]);

export function isProtectedTool(name: string): boolean {
  return PROTECTED_TOOL_NAMES.has(name);
}

/** The SDK's registerTool config (Standard Schema form; raw zod shapes are not accepted here). */
type ToolConfig<InputArgs extends StandardSchemaWithJSON | undefined> = {
  title?: string;
  description?: string;
  inputSchema?: InputArgs;
  outputSchema?: StandardSchemaWithJSON;
  annotations?: ToolAnnotations;
  icons?: Icon[];
  _meta?: Record<string, unknown>;
};

type ProtectedHandler<InputArgs extends StandardSchemaWithJSON | undefined> = InputArgs extends StandardSchemaWithJSON
  ? (
      args: StandardSchemaWithJSON.InferOutput<InputArgs>,
      access: Access,
      ctx: ServerContext,
    ) => ReturnType<ToolCallback<InputArgs>>
  : (access: Access, ctx: ServerContext) => ReturnType<ToolCallback<undefined>>;

/**
 * registerTool for a tool that needs a signed-in user. The handler runs only
 * with an Access; without one the caller gets the sign-in challenge result.
 */
export function registerProtectedTool<InputArgs extends StandardSchemaWithJSON | undefined = undefined>(
  server: McpServer,
  runtime: AuthRuntime,
  name: string,
  config: ToolConfig<InputArgs>,
  handler: ProtectedHandler<InputArgs>,
): void {
  if (!PROTECTED_TOOL_NAMES.has(name)) {
    throw new Error(`registerProtectedTool("${name}"): add the name to PROTECTED_TOOL_NAMES so the HTTP gate knows it`);
  }
  const description = config.description
    ? `${config.description} Requires signing in with a LuxAlgo account (OAuth).`
    : "Requires signing in with a LuxAlgo account (OAuth).";

  const guarded = async (...callArgs: unknown[]) => {
    const ctx = callArgs[callArgs.length - 1] as ServerContext;
    // The ambient token (instrumentToolRegistration) when the caller already
    // has one; otherwise let the runtime obtain one — on stdio that may be an
    // in-session browser sign-in — and make it ambient for the handler so
    // its appGet calls carry it too.
    const access = currentAccess() ?? (await runtime.resolveAccess(ctx));
    if (!access) {
      return signInRequiredResult({}, runtime.signInHint);
    }
    return runWithAccess(access, () =>
      callArgs.length === 2
        ? (handler as (a: unknown, b: Access, c: ServerContext) => unknown)(callArgs[0], access, ctx)
        : (handler as (a: Access, b: ServerContext) => unknown)(access, ctx),
    );
  };

  // The SDK's overloads are keyed on inputSchema presence; the cast keeps
  // the strongly typed public signature above without re-deriving them.
  (server.registerTool as unknown as (n: string, c: unknown, cb: unknown) => void)(
    name,
    { ...config, description },
    guarded,
  );
}

/**
 * Adds `securitySchemes` to every tool in tools/list. The SDK builds that
 * response from a fixed field set, so the list handler is wrapped after all
 * tools are registered. Call once per server instance, last.
 */
export function advertiseSecuritySchemes(server: McpServer): void {
  type ListHandler = (request: unknown, ctx: unknown) => Promise<{ tools: Array<{ name: string } & Record<string, unknown>> }>;
  const protocol = server.server as unknown as { _requestHandlers?: Map<string, ListHandler> };
  const original = protocol._requestHandlers?.get("tools/list");
  if (!original) return; // no tools registered, or SDK internals moved — tools/list still works, just without the hint

  const publicScheme = [{ type: "noauth" }];
  const oauthScheme = [{ type: "oauth2", scopes: [...OAUTH_SCOPES] }];
  server.server.setRequestHandler("tools/list", (async (request: unknown, ctx: unknown) => {
    const result = await original(request, ctx);
    return {
      ...result,
      tools: result.tools.map((tool) => ({
        ...tool,
        securitySchemes: PROTECTED_TOOL_NAMES.has(tool.name) ? oauthScheme : publicScheme,
      })),
    };
  }) as never);
}

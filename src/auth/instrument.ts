/*
  Server-wide wrappers applied once per McpServer instance:

    instrumentToolRegistration  BEFORE any registerTool — every tool runs
                                with the caller's token ambient and the
                                app's 401/403 mapped to proper tool results
    advertiseSecuritySchemes    AFTER the last registerTool — tools/list
                                carries a per-tool `securitySchemes` array
                                (OpenAI's MCP extension: `noauth` for public
                                tools, `oauth2` + scopes for protected ones)
                                so ChatGPT knows which tools unlock after
                                linking; other clients ignore the field.
                                Left out on the Claude host (surface.ts),
                                whose anonymous surface must look authless
*/
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { OAUTH_SCOPES } from "./config.js";
import { appErrorResult } from "./errors.js";
import { runWithAccess } from "./access-context.js";
import { currentSurface } from "./surface.js";
import type { AuthRuntime } from "./runtime.js";

/**
 * Makes every tool registered on `server` from now on run with (a) the
 * caller's token ambient for the whole call — appGet forwards it on every
 * app request, public tools included — and (b) the app's 401/403 turned into
 * proper tool results instead of the SDK's generic "Error: …" text. The SDK
 * converts thrown errors inside its tools/call handler, so this has to wrap
 * the callbacks themselves rather than the request handler.
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
 * Adds `securitySchemes` to every tool in tools/list, on hosts that want it
 * (surface.ts). The SDK builds that response from a fixed field set, so the
 * list handler is wrapped after all tools are registered.
 */
export function advertiseSecuritySchemes(server: McpServer, protectedTools: ReadonlySet<string>): void {
  type ListHandler = (request: unknown, ctx: unknown) => Promise<{ tools: Array<{ name: string } & Record<string, unknown>> }>;
  const protocol = server.server as unknown as { _requestHandlers?: Map<string, ListHandler> };
  const original = protocol._requestHandlers?.get("tools/list");
  if (!original) return; // no tools registered, or SDK internals moved — tools/list still works, just without the hint

  const publicScheme = [{ type: "noauth" }];
  const oauthScheme = [{ type: "oauth2", scopes: [...OAUTH_SCOPES] }];
  server.server.setRequestHandler("tools/list", (async (request: unknown, ctx: unknown) => {
    const result = await original(request, ctx);
    if (!currentSurface().securitySchemes) return result;
    return {
      ...result,
      tools: result.tools.map((tool) => ({
        ...tool,
        securitySchemes: protectedTools.has(tool.name) ? oauthScheme : publicScheme,
      })),
    };
  }) as never);
}

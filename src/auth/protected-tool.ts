/*
  registerTool for a tool that needs a signed-in LuxAlgo user. Everything
  else on this server works anonymously; a protected tool is one whose
  handler receives an `Access` (the user's OAuth access token + identity) and
  is refused with a sign-in challenge when there is none.

  Whether a tool is "protected" only changes the UX — the challenge comes
  before a pointless round-trip, and clients learn from tools/list which
  tools unlock after linking. Security does not depend on it: the app
  re-checks every forwarded token. A protected tool must also be listed in
  its module's `protectedTools` (tools/_shared/module.ts) — that is what the
  HTTP gate and the securitySchemes hint read; createLuxalgoServer verifies
  the two agree.
*/
import type {
  Icon,
  McpServer,
  ServerContext,
  StandardSchemaWithJSON,
  ToolAnnotations,
  ToolCallback,
} from "@modelcontextprotocol/server";
import { signInRequiredResult } from "./challenge.js";
import { currentAccess, runWithAccess, type Access } from "./access-context.js";
import type { AuthRuntime } from "./runtime.js";

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

/** The handler runs only with an Access; without one the caller gets the sign-in challenge result. */
export function registerProtectedTool<InputArgs extends StandardSchemaWithJSON | undefined = undefined>(
  server: McpServer,
  runtime: AuthRuntime,
  name: string,
  config: ToolConfig<InputArgs>,
  handler: ProtectedHandler<InputArgs>,
): void {
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

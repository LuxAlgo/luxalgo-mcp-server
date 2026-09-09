/*
  Account tools — the ones that need a signed-in LuxAlgo user. Like every
  other tool they just call the app's API; the difference is that these
  routes require a user, so the tool is registered as protected: the caller
  gets the sign-in challenge up front instead of after a wasted round-trip.
  The token itself travels with the request (auth/access-context.ts) and the
  app resolves the user from it exactly as it would from a browser session.
  Same implementation on every entry; only where the token comes from differs
  (client bearer when hosted, local store on stdio).
*/
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { appGet } from "../../platform/app-client.js";
import { registerProtectedTool } from "../../auth/protected-tool.js";
import type { AuthRuntime } from "../../auth/runtime.js";
import { json } from "../_shared/result.js";

type AccountMe = {
  user: { id: string; email: string; name: string; image: string | null; roles: string[] };
  plan: string;
  permissions: Record<string, unknown>;
};

export function registerAccountTools(server: McpServer, runtime: AuthRuntime) {
  registerProtectedTool(
    server,
    runtime,
    "luxalgo_account",
    {
      title: "My LuxAlgo account",
      description:
        "The signed-in user's LuxAlgo account: plan tier, entitlements (limits such as alerts, historical bars, AI credits) and profile basics. Use it to tailor answers to what the user's plan actually allows, or when the user asks what plan they are on.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      // A 401 here (token revoked, user deleted) surfaces as the sign-in
      // challenge through the shared error mapping — nothing to do locally.
      const { user, plan, permissions } = await appGet<AccountMe>("/api/account/me");
      return json({
        user: { id: user.id, email: user.email, name: user.name, roles: user.roles },
        plan,
        permissions,
        // Numeric `null` means unlimited (the app serialises Infinity as null).
        note: "In permissions, a null number means unlimited on this plan.",
      });
    },
  );
}

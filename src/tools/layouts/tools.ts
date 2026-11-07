/*
  The member's saved Vela layouts (the app calls them workspaces: a chart's
  tabs, panels and drawings, saved under a name). Read only: the app's MCP
  allowlist reaches the list and nothing that saves, shares, duplicates or
  deletes one. Each layout opens in Vela at /chart/<id> (the app's
  chart-address.ts), which is the "Open in Vela" link a result carries.
*/
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerProtectedTool } from "../../auth/protected-tool.js";
import type { AuthRuntime } from "../../auth/runtime.js";
import { appGet } from "../../platform/app-client.js";
import { guarded, ok } from "../_shared/result.js";
import { CHART_ORIGIN } from "../_shared/vela.js";

type WorkspaceSummary = { id: string; name: string; updatedAt: string; shared: boolean };

/** A saved layout opened in Vela. */
export const layoutUrl = (id: string): string => `${CHART_ORIGIN}/chart/${encodeURIComponent(id)}`;

export function registerLayoutTools(server: McpServer, runtime: AuthRuntime) {
  registerProtectedTool(
    server,
    runtime,
    "layouts_list",
    {
      title: "My saved Vela layouts",
      description:
        "The signed-in member's saved Vela layouts (workspaces), newest first: each one's name, id, when it was last saved, whether it has a share link, and its Vela link (chart_url) that opens that layout. Use it when the member asks for their saved charts or layouts or wants one opened. Read only: it cannot save, rename, share or delete a layout. For a single market on a chart, give that market's chart_url instead.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async () =>
      guarded(async () => {
        const { workspaces } = await appGet<{ workspaces: WorkspaceSummary[] }>("/api/quant/workspaces");
        if (workspaces.length === 0) {
          return ok(`The member has no saved layout yet. Vela saves one from the chart: ${CHART_ORIGIN}/chart`, { layouts: [] });
        }
        const layouts = workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          updated_at: w.updatedAt,
          shared: w.shared,
          chart_url: layoutUrl(w.id),
        }));
        const lines = layouts.map(
          (l) => `- "${l.name}" (id ${l.id}), last saved ${l.updated_at.slice(0, 10)}${l.shared ? ", shared" : ""}: ${l.chart_url}`,
        );
        return ok(`${layouts.length} saved layout${layouts.length === 1 ? "" : "s"}:\n${lines.join("\n")}`, { layouts });
      }),
  );
}

import type { ToolModule } from "../_shared/module.js";
import { onChatGptAddress } from "../_shared/surface.js";
import { registerTrackersTools } from "./tools.js";

const TRACKERS_TOOLS = ["trackers_datasets", "trackers_query", "trackers_latest", "trackers_ticker"] as const;

/**
 * Market Trackers: the public record of US markets from CC0 dumps. Keyless.
 *
 * Not on the ChatGPT address: `register` returns early there and
 * `omitFromDirectory` (a getter, read at registration inside the request's
 * surface) names all four tools there only, which is what the startup
 * manifest check compares against. The standard address, stdio and the
 * Claude address keep them; the Claude address keeps its "directory"
 * variant, exactly as it is under review.
 */
export const trackersModule: ToolModule = {
  id: "trackers",
  tools: TRACKERS_TOOLS,
  get omitFromDirectory() {
    return onChatGptAddress() ? TRACKERS_TOOLS : [];
  },
  register: (server, { toolset }) => {
    if (onChatGptAddress()) return;
    registerTrackersTools(server, toolset);
  },
};

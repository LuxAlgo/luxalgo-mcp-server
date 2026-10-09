import type { ToolModule } from "../_shared/module.js";
import { TRACKERS_OMITTED_FROM_OPENAI, registerTrackersTools } from "./tools.js";

/** Market Trackers: the public record of US markets from CC0 dumps. Keyless. */
export const trackersModule: ToolModule = {
  id: "trackers",
  tools: ["trackers_datasets", "trackers_query", "trackers_latest", "trackers_ticker"],
  omitFromOpenAi: TRACKERS_OMITTED_FROM_OPENAI,
  register: (server, { toolset }) => registerTrackersTools(server, toolset),
};

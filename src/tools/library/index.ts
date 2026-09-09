import type { ToolModule } from "../_shared/module.js";
import { registerLibraryTools } from "./tools.js";

/** The Library encyclopedia: concepts, families, indicators, tags, Pine source. Keyless. */
export const libraryModule: ToolModule = {
  id: "library",
  tools: [
    "library_search",
    "library_list_families",
    "library_get_family",
    "library_list_concepts",
    "library_get_concept",
    "library_list_indicators",
    "library_get_indicator",
    "library_get_source_code",
    "library_list_tags",
  ],
  register: (server) => registerLibraryTools(server),
};

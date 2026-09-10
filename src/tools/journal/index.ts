import type { ToolModule } from "../_shared/module.js";
import { registerJournalTools } from "./tools.js";

const JOURNAL_TOOLS = [
  "journal_list_accounts",
  "journal_overview",
  "journal_calendar",
  "journal_breakdown",
  "journal_list_trades",
  "journal_get_trade",
  "journal_get_day",
  "journal_list_tags",
  "journal_search_notes",
  "journal_add_trade",
  "journal_update_trade",
  "journal_write_note",
  "journal_update_note",
] as const;

/** The signed-in user's trade journal. Every route needs a user, so every tool is protected. */
export const journalModule: ToolModule = {
  id: "journal",
  tools: JOURNAL_TOOLS,
  protectedTools: JOURNAL_TOOLS,
  register: (server, { auth }) => registerJournalTools(server, auth),
};

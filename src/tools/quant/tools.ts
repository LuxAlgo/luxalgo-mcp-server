/*
  Quant tools: Quant, our coding agent, writing and checking Pine Script® for
  the signed-in user from their own AI assistant. Both app routes need a
  user, so both tools are protected and the caller meets the sign-in
  challenge before anything is sent.

  The app owns everything that matters: it runs Quant, spends the user's plan
  usage on a generation exactly as Quant in Vela does, and refuses with its
  own message when the plan has no Quant usage left (402) or the user is rate
  limited (429). guarded() relays those messages as tool errors and lets the
  sign-in (401) and plan (403) answers through to the auth wrapper. Nothing
  about plans or usage is decided here (docs/auth.md §1), and nothing is
  cached: every answer is the user's own.

  Scripts are checked by our linter, which reports the same errors as
  TradingView's compiler. Nothing here runs a script, so no copy says one
  was run or tested.
*/
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerProtectedTool } from "../../auth/protected-tool.js";
import type { AuthRuntime } from "../../auth/runtime.js";
import { compact } from "../_shared/format.js";
import { guarded, json } from "../_shared/result.js";
import { VELA_CHART_URL } from "../_shared/vela.js";
import { generatePine, validatePine } from "./api.js";

/** The Quant API's documented input limits; the app enforces its own, and its 400/413 message is relayed. */
const MAX_PROMPT_CHARS = 20_000;
const MAX_CODE_CHARS = 200_000;

export function registerQuantTools(server: McpServer, runtime: AuthRuntime) {
  registerProtectedTool(
    server,
    runtime,
    "quant_generate_pine",
    {
      title: "Write Pine Script® with Quant",
      description:
        "Quant, our coding agent, built into Vela, writes a Pine Script® indicator or strategy from the user's request, or changes an existing script passed as `code`. Use it when the user wants a Pine Script® indicator or strategy written or changed. Each call spends the signed-in user's LuxAlgo plan usage, the same usage Quant draws on in Vela; when none is left, the result is the app's message saying so. Quant checks each attempt with our linter, which reports the same errors as TradingView's compiler, and fixes what it finds. `status` is `working` when the returned code passes the linter with no errors (warnings allowed), or `failed` when Quant could not get it past the linter: `validation.errors` then lists what is still wrong (line, column, message) and `code` holds the last attempt, if there was one. The linter checks the code; the script has not been run or backtested. Returns status, title, script_type, attempts, validation (valid, errors, warnings), code, and `vela_url`, the link to Vela, our next-generation charting platform. quant_validate_pine checks code without writing any, for free. To find an existing LuxAlgo indicator instead of writing one, use library_search; library_get_source_code returns its source.",
      inputSchema: z.object({
        prompt: z
          .string()
          .trim()
          .min(1)
          .max(MAX_PROMPT_CHARS)
          .describe(
            "What the script should do, or what to change in `code`, in the user's words, with the details they gave (inputs, plots, entry and exit rules, timeframe).",
          ),
        code: z
          .string()
          .max(MAX_CODE_CHARS)
          .optional()
          .describe(
            "An existing Pine Script® to change: the user's own, or `code` from an earlier quant_generate_pine result to keep iterating. Omit to write a new script.",
          ),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ prompt, code }) =>
      guarded(async () => {
        const generation = await generatePine({
          prompt,
          // An empty `code` means "write a new one", not "change this blank script".
          ...(code?.trim() ? { code } : {}),
        });
        return json(
          compact({
            id: generation.id,
            status: generation.status,
            title: generation.title,
            script_type: generation.script_type,
            attempts: generation.attempts,
            billed_to: generation.billed_to,
            validation: generation.validation,
            code: generation.code,
            vela_url: VELA_CHART_URL,
          }),
        );
      }),
  );

  registerProtectedTool(
    server,
    runtime,
    "quant_validate_pine",
    {
      title: "Check Pine Script® code",
      description:
        "Checks Pine Script® code with LuxAlgo's linter, which reports the same errors as TradingView's compiler. Returns `valid` plus the linter's `errors` and `warnings`, each with line, column (when known) and message. Free: it spends no plan usage. It only checks the code; it does not run, fix or change it. Use it to check Pine Script® the assistant wrote itself before handing it to the user, or code the user shares. To have Quant, our coding agent, write or fix a script, use quant_generate_pine, whose results are already checked.",
      inputSchema: z.object({
        code: z.string().min(1).max(MAX_CODE_CHARS).describe("The full Pine Script® source to check."),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ code }) =>
      guarded(async () => {
        const { valid, errors, warnings } = await validatePine(code);
        return json(compact({ valid, errors, warnings }));
      }),
  );
}

/*
  The six simulator tools re-registered from @luxalgo/prop-firm-sim-mcp's
  exported toolDefinitions under this repo's propfirms_ naming convention.
  Cross-references inside descriptions and schema field descriptions are
  rewritten to the local names so agents are pointed at tools that exist
  here: propfirms_list_simulatable, propfirms_challenge_rules,
  propfirms_simulate, propfirms_optimal_risk, propfirms_compare,
  propfirms_simulate_trades. Handlers are the package's own — parity with
  upstream is covered by `npm run test:parity`.
*/
import { z } from "zod";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { toolDefinitions } from "@luxalgo/prop-firm-sim-mcp/tools";
import { fetchDirectory, resolveFirm } from "@luxalgo/prop-firm-sim-mcp/directory";
import type { Toolset } from "../../../auth/surface.js";
import { keyedCache } from "../../_shared/cache.js";
import { answersFrozen } from "../../_shared/surface.js";
import { directoryCopy } from "./directory-copy.js";
import { fmtCurrency, plainResultText } from "./result-text.js";


/** Package-name -> local-name map for the tools this server exposes
 *  (analyze_portfolio_overlap is deliberately left out of the surface for
 *  now). Values follow the existing propfirms_* naming convention. */
const TOOL_RENAMES: Record<string, string> = {
  list_firms: "propfirms_list_simulatable",
  get_challenge_rules: "propfirms_challenge_rules",
  simulate_challenge: "propfirms_simulate",
  optimal_risk: "propfirms_optimal_risk",
  compare_challenges: "propfirms_compare",
  bootstrap_simulate: "propfirms_simulate_trades",
};

/** Every upstream name that must not surface here: the six renamed tools,
 *  plus analyze_portfolio_overlap (not exposed), whose mentions point at
 *  the result field that carries the same analysis instead. */
const REFERENCE_REWRITES: Record<string, string> = {
  ...TOOL_RENAMES,
  analyze_portfolio_overlap: "the attached structuredContent.portfolioOverlap analysis",
};

/** Rewrite sibling-tool references inside a description to the local
 *  names, so agents are pointed at tools that actually exist here. */
function rewriteToolReferences(description: string): string {
  let out = description;
  const names = Object.keys(REFERENCE_REWRITES).sort((a, b) => b.length - a.length);
  for (const name of names) {
    out = out.replace(new RegExp(`\\b${name}\\b`, "g"), REFERENCE_REWRITES[name]!);
  }
  return out;
}

/** Rewrite tool references inside a zod schema's field descriptions,
 *  recursively (wrappers, arrays, records, nested objects, unions, pipes),
 *  returning a new schema so the upstream definitions stay untouched.
 *  Descriptions are the only thing changed: agents read them in tools/list,
 *  and the upstream ones reference tool names that do not exist under those
 *  names here.
 *
 *  zod 4 internals: the definition lives at `_zod.def`, child schemas hang
 *  off well-known def keys, and `.describe()` text is registry metadata
 *  (read via `schema.description`), not a def field. `clone(def)` yields a
 *  fresh instance of the same class with every check preserved; `.describe`
 *  then attaches the rewritten text to that new instance only. */
export function rewriteSchemaDescriptions<T extends z.ZodType>(
  schema: T,
  transform: (text: string) => string = rewriteToolReferences,
): T {
  const def = { ...schema._zod.def } as Record<string, unknown>;
  const isSchema = (value: unknown): value is z.ZodType => value instanceof z.ZodType;
  // optional / nullable / default / prefault / catch / readonly / nonoptional
  if (isSchema(def.innerType)) def.innerType = rewriteSchemaDescriptions(def.innerType, transform);
  if (isSchema(def.element)) def.element = rewriteSchemaDescriptions(def.element, transform); // array / set
  if (isSchema(def.keyType)) def.keyType = rewriteSchemaDescriptions(def.keyType, transform); // record / map
  if (isSchema(def.valueType)) def.valueType = rewriteSchemaDescriptions(def.valueType, transform);
  if (isSchema(def.in)) def.in = rewriteSchemaDescriptions(def.in, transform); // pipe / transform
  if (isSchema(def.out)) def.out = rewriteSchemaDescriptions(def.out, transform);
  if (Array.isArray(def.options)) {
    def.options = def.options.map((option: unknown) =>
      isSchema(option) ? rewriteSchemaDescriptions(option, transform) : option,
    ); // union
  }
  if (def.shape !== null && typeof def.shape === "object") {
    def.shape = Object.fromEntries(
      Object.entries(def.shape as Record<string, unknown>).map(([key, field]) => [
        key,
        isSchema(field) ? rewriteSchemaDescriptions(field, transform) : field,
      ]),
    ); // object
  }
  const next = schema.clone(def as unknown as T["_zod"]["def"]) as T;
  const description = schema.description;
  return typeof description === "string"
    ? (next.describe(transform(description)) as T)
    : next;
}

/** rewriteSchemaDescriptions over every field of a raw shape. ZodRawShape is
 *  typed over zod-core's $ZodType; the upstream shapes are built with the
 *  classic API, so every field is a full ZodType at runtime (asserted). */
function rewriteShapeDescriptions(shape: z.ZodRawShape, transform: (text: string) => string): z.ZodRawShape {
  return Object.fromEntries(
    Object.entries(shape).map(([key, field]) => {
      if (!(field instanceof z.ZodType)) {
        throw new Error(`upstream inputShape.${key} is not a zod classic schema`);
      }
      return [key, rewriteSchemaDescriptions(field, transform)];
    }),
  );
}

/** Appended to specific renamed tools so agents route correctly between
 *  the two propfirms_ groups: the simulator sees only what its engine can
 *  encode honestly, while the propfirms_search* tools serve the full
 *  directory (every visible firm, listed prices and terms, live offers). */
const ROUTING_NOTES: Record<Toolset, Record<string, string>> = {
  full: {
    propfirms_list_simulatable:
      " NOTE: this lists only the firms and challenges whose rules the engine can encode honestly. " +
      "The full directory — every visible firm with platforms, prices, payout terms, and live " +
      "offers/promo codes — is served by propfirms_search, propfirms_search_challenges, and " +
      "propfirms_search_offers.",
    propfirms_challenge_rules:
      " NOTE: this returns the simulatable encoding of one challenge's rules; the directory listing " +
      "with every captured field, plus live offers, is propfirms_get and propfirms_search_challenges.",
  },
  // No offers on the "directory" toolset (directory-tools.ts).
  directory: {
    propfirms_list_simulatable:
      " NOTE: this lists only the firms and challenges whose rules the engine can encode honestly. " +
      "The full directory — every visible firm with platforms, prices, and payout terms — is served " +
      "by propfirms_search and propfirms_search_challenges.",
    propfirms_challenge_rules:
      " NOTE: this returns the simulatable encoding of one challenge's rules; the directory listing " +
      "with every captured field is propfirms_get and propfirms_search_challenges.",
  },
};


/** Upstream description text this surface drops or rewords: a pointer at
 *  other MCP servers' tools (directory review forbids metadata that steers
 *  the model's use of other plugins), self-promotion, internal config and
 *  stale migration notes. Applied in order to every package description. */
const DESCRIPTION_EDITS: ReadonlyArray<[RegExp, string]> = [
  [/\s*Composes with any broker-statistics tool:[\s\S]*$/, ""],
  [/ - a distinguishing feature of this engine/g, ""],
  [/ \(origin overridable via the LUXALGO_APP_ORIGIN env var\)/g, ""],
  [/ The pre-1\.0 flag id '[^']*' no longer exists\./g, ""],
  [/WHY THIS BEATS WIN-RATE MATH: /g, "Why resampling matters: "],
];

/** Appended after the edits, like ROUTING_NOTES. */
const DESCRIPTION_NOTES: Record<string, string> = {
  propfirms_optimal_risk:
    " Results describe simulated outcomes of the user's own inputs under stated assumptions; " +
    "they are not financial advice or a recommendation of any risk level.",
};

function editDescription(description: string): string {
  return DESCRIPTION_EDITS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), description);
}

/** Local names of the package tools, in registration order (for the module manifest). */
export const PACKAGE_TOOL_NAMES: readonly string[] = toolDefinitions
  .map((def) => TOOL_RENAMES[def.name])
  .filter((name): name is string => name !== undefined);

/*
  Deterministic simulations, cached per exact arguments. The same inputs and
  seed give byte-identical results, so a repeated question (a model re-asking,
  or a second user asking the same thing) is answered without re-running the
  Monte Carlo. A directory challenge's rules come from the live directory, so
  entries are kept per directory snapshot (the package refreshes it every
  five minutes): new rules never meet an old result. The trade-series tool is
  left out on purpose: its inputs are the user's own trades.
*/
const CACHED_SIMULATIONS = new Set(["simulate_challenge", "optimal_risk", "compare_challenges"]);
const MAX_CACHED_ARGS = 64 * 1024;
const INLINE_ONLY = {};
const simulationCaches = new WeakMap<object, KeyedCache>();
type KeyedCache = ReturnType<typeof keyedCache<CallToolResult>>;

function namesDirectoryChallenge(args: unknown): boolean {
  const record = (args ?? {}) as { firmId?: unknown; challenges?: unknown };
  if (record.firmId !== undefined) return true;
  return Array.isArray(record.challenges) && record.challenges.some((entry) => (entry as { firmId?: unknown })?.firmId !== undefined);
}

async function cachedSimulation(
  name: string,
  args: unknown,
  run: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  if (!CACHED_SIMULATIONS.has(name)) return run();
  const key = JSON.stringify(args ?? {});
  if (key.length > MAX_CACHED_ARGS) return run();
  let snapshot: object = INLINE_ONLY;
  if (namesDirectoryChallenge(args)) {
    try {
      snapshot = await fetchDirectory();
    } catch {
      return run(); // the handler reports the unreachable directory itself
    }
  }
  let cache = simulationCaches.get(snapshot);
  if (!cache) {
    cache = keyedCache<CallToolResult>({ ttlMs: 30 * 60 * 1000, max: 100 });
    simulationCaches.set(snapshot, cache);
  }
  return cache.get(`${name}:${key}`, async () => {
    const result = await run();
    if (result.isError) throw Object.assign(new Error("not cached"), { result });
    return result;
  }).catch((error: unknown) => {
    const failed = (error as { result?: CallToolResult }).result;
    if (failed) return failed;
    throw error;
  });
}

/*
  propfirms_list_simulatable off the Claude address: the package lists every
  simulatable challenge of every firm (about 300, over 150 KB with its
  structured twin). Without firmId the answer is one line per firm; with
  firmId it is that firm's full entry, exactly as the package lists it.
*/
const LIST_FIRM_ID_FIELD = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Directory firm id or firm name (e.g. 'ftmo'). Returns that firm's simulatable challenges (ids, names, " +
      "account sizes, prices, provenance). Omit for one line per firm.",
  );

const LIST_SUMMARY_NOTE =
  " Without firmId the result is one line per firm (simulatable challenge count, account-size range, " +
  "challenges that are not simulatable); with firmId it lists that firm's challenges with their ids.";

type ListedChallenge = { accountSize: number; currency: string; productType: string };
type ListedFirm = { firmId: string; name: string; challenges: ListedChallenge[]; notSimulatable?: string[] };

function listSummary(result: CallToolResult, productType: string | undefined): CallToolResult {
  const structured = (result.structuredContent ?? {}) as { firms?: ListedFirm[]; engineVersion?: string; disclaimer?: string };
  const firms = (structured.firms ?? []).map((firm) => {
    const sizes = firm.challenges.map((c) => c.accountSize);
    const currencies = [...new Set(firm.challenges.map((c) => c.currency.toUpperCase()))];
    return {
      firmId: firm.firmId,
      name: firm.name,
      simulatableChallenges: firm.challenges.length,
      productTypes: [...new Set(firm.challenges.map((c) => c.productType))],
      ...(sizes.length > 0
        ? { accountSizeMin: Math.min(...sizes), accountSizeMax: Math.max(...sizes), currencies }
        : {}),
      ...(firm.notSimulatable ? { notSimulatable: firm.notSimulatable.length } : {}),
    };
  });
  const range = (firm: (typeof firms)[number]) => {
    if (firm.accountSizeMin === undefined) return "";
    const currency = firm.currencies?.[0] ?? "USD";
    const min = fmtCurrency(firm.accountSizeMin, currency);
    const max = fmtCurrency(firm.accountSizeMax ?? firm.accountSizeMin, currency);
    return `, ${min === max ? min : `${min} to ${max}`}`;
  };
  const lines = [
    `${firms.length} firm(s) in the live LuxAlgo directory` +
      (productType ? ` with ${productType} challenges` : "") +
      " (alphabetical - data, not endorsement or ranking). firmId lists one firm's challenges with their ids:",
    ...firms.map(
      (firm) =>
        `${firm.firmId} - ${firm.name}: ${firm.simulatableChallenges} simulatable` +
        (firm.productTypes.length > 0 ? ` (${firm.productTypes.join(", ")})` : "") +
        range(firm) +
        (firm.notSimulatable ? `; ${firm.notSimulatable} not simulatable (ambiguous rule text)` : ""),
    ),
    "Each firm's own page is authoritative.",
  ];
  if (structured.disclaimer) lines.push(structured.disclaimer);
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { firms, engineVersion: structured.engineVersion, disclaimer: structured.disclaimer },
  };
}

/** One firm's entry: the package's own lines and structured row for it, nothing else. */
async function listOneFirm(result: CallToolResult, firmId: string, productType: string | undefined): Promise<CallToolResult> {
  const firm = resolveFirm(await fetchDirectory(), firmId); // throws with the known firms
  const structured = (result.structuredContent ?? {}) as { firms?: ListedFirm[]; engineVersion?: string; disclaimer?: string };
  const row = (structured.firms ?? []).find((entry) => entry.firmId === firm.propfirmId);
  if (!row) {
    return {
      content: [
        {
          type: "text",
          text:
            `${firm.name} (${firm.propfirmId}) has no ` +
            (productType ? `${productType} ` : "") +
            "challenges the engine can simulate in the live LuxAlgo directory.",
        },
      ],
      isError: true,
    };
  }
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  const lines = text.split("\n");
  const start = lines.indexOf(`${row.firmId} - ${row.name}`);
  const block: string[] = [];
  for (let i = start + 1; start >= 0 && i < lines.length && lines[i]!.startsWith("  - "); i++) block.push(lines[i]!);
  const out = [
    `${row.firmId} - ${row.name} in the live LuxAlgo directory:`,
    ...block,
    ...lines.filter((line) => line.startsWith("Provenance 'directory+inferred'")),
  ];
  if (structured.disclaimer) out.push(structured.disclaimer);
  return {
    content: [{ type: "text", text: out.join("\n") }],
    structuredContent: { firms: [row], engineVersion: structured.engineVersion, disclaimer: structured.disclaimer },
  };
}

export function registerPackageSimTools(server: McpServer, toolset: Toolset): void {
  const copy = (text: string) => (toolset === "directory" ? directoryCopy(text) : text);
  const frozen = answersFrozen();
  for (const def of toolDefinitions) {
    const localName = TOOL_RENAMES[def.name];
    if (localName === undefined) continue;
    const compactList = !frozen && def.name === "list_firms";
    const shape = rewriteShapeDescriptions(def.inputShape, (text) => copy(rewriteToolReferences(text)));
    server.registerTool(
      localName,
      {
        title: def.title,
        description:
          copy(editDescription(rewriteToolReferences(def.description))) +
          (compactList ? LIST_SUMMARY_NOTE : "") +
          (ROUTING_NOTES[toolset][localName] ?? "") +
          (DESCRIPTION_NOTES[localName] ?? ""),
        inputSchema: z.object(compactList ? { ...shape, firmId: LIST_FIRM_ID_FIELD } : shape),
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      },
      async (args: unknown): Promise<CallToolResult> => {
        let result: CallToolResult;
        if (compactList) {
          const { firmId, ...rest } = (args ?? {}) as { firmId?: string; productType?: string };
          const listed = (await def.handler(rest)) as CallToolResult;
          if (listed.isError) {
            result = listed;
          } else {
            try {
              result = firmId === undefined ? listSummary(listed, rest.productType) : await listOneFirm(listed, firmId, rest.productType);
            } catch (error) {
              result = { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
            }
          }
        } else {
          result = await cachedSimulation(def.name, args, async () => (await def.handler(args)) as CallToolResult);
        }
        // Result prose may also point at sibling tools (e.g. list_firms
        // suggests get_challenge_rules) — rewrite those references too.
        // Off the Claude address the prose is also restated in plain
        // language (result-text.ts). Structured content is data and passes
        // through untouched.
        return {
          ...result,
          content: result.content.map((item) => {
            if (item.type !== "text") return item;
            const text = rewriteToolReferences(item.text);
            return { ...item, text: frozen ? text : plainResultText(text, result.structuredContent) };
          }),
        } as CallToolResult;
      },
    );
  }
}

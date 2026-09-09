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
function rewriteSchemaDescriptions<T extends z.ZodType>(schema: T): T {
  const def = { ...schema._zod.def } as Record<string, unknown>;
  const isSchema = (value: unknown): value is z.ZodType => value instanceof z.ZodType;
  // optional / nullable / default / prefault / catch / readonly / nonoptional
  if (isSchema(def.innerType)) def.innerType = rewriteSchemaDescriptions(def.innerType);
  if (isSchema(def.element)) def.element = rewriteSchemaDescriptions(def.element); // array / set
  if (isSchema(def.keyType)) def.keyType = rewriteSchemaDescriptions(def.keyType); // record / map
  if (isSchema(def.valueType)) def.valueType = rewriteSchemaDescriptions(def.valueType);
  if (isSchema(def.in)) def.in = rewriteSchemaDescriptions(def.in); // pipe / transform
  if (isSchema(def.out)) def.out = rewriteSchemaDescriptions(def.out);
  if (Array.isArray(def.options)) {
    def.options = def.options.map((option: unknown) =>
      isSchema(option) ? rewriteSchemaDescriptions(option) : option,
    ); // union
  }
  if (def.shape !== null && typeof def.shape === "object") {
    def.shape = Object.fromEntries(
      Object.entries(def.shape as Record<string, unknown>).map(([key, field]) => [
        key,
        isSchema(field) ? rewriteSchemaDescriptions(field) : field,
      ]),
    ); // object
  }
  const next = schema.clone(def as unknown as T["_zod"]["def"]) as T;
  const description = schema.description;
  return typeof description === "string"
    ? (next.describe(rewriteToolReferences(description)) as T)
    : next;
}

/** rewriteSchemaDescriptions over every field of a raw shape. ZodRawShape is
 *  typed over zod-core's $ZodType; the upstream shapes are built with the
 *  classic API, so every field is a full ZodType at runtime (asserted). */
function rewriteShapeDescriptions(shape: z.ZodRawShape): z.ZodRawShape {
  return Object.fromEntries(
    Object.entries(shape).map(([key, field]) => {
      if (!(field instanceof z.ZodType)) {
        throw new Error(`upstream inputShape.${key} is not a zod classic schema`);
      }
      return [key, rewriteSchemaDescriptions(field)];
    }),
  );
}

/** Appended to specific renamed tools so agents route correctly between
 *  the two propfirms_ groups: the simulator sees only what its engine can
 *  encode honestly, while the propfirms_search* tools serve the full
 *  directory (every visible firm, listed prices and terms, live offers). */
const ROUTING_NOTES: Record<string, string> = {
  propfirms_list_simulatable:
    " NOTE: this lists only the firms and challenges whose rules the engine can encode honestly. " +
    "The full directory — every visible firm with platforms, prices, payout terms, and live " +
    "offers/promo codes — is served by propfirms_search, propfirms_search_challenges, and " +
    "propfirms_search_offers.",
  propfirms_challenge_rules:
    " NOTE: this returns the simulatable encoding of one challenge's rules; the directory listing " +
    "with every captured field, plus live offers, is propfirms_get and propfirms_search_challenges.",
};


/** Local names of the package tools, in registration order (for the module manifest). */
export const PACKAGE_TOOL_NAMES: readonly string[] = toolDefinitions
  .map((def) => TOOL_RENAMES[def.name])
  .filter((name): name is string => name !== undefined);

export function registerPackageSimTools(server: McpServer): void {
  for (const def of toolDefinitions) {
    const localName = TOOL_RENAMES[def.name];
    if (localName === undefined) continue;
    server.registerTool(
      localName,
      {
        title: def.title,
        description: rewriteToolReferences(def.description) + (ROUTING_NOTES[localName] ?? ""),
        inputSchema: z.object(rewriteShapeDescriptions(def.inputShape)),
      },
      async (args: unknown): Promise<CallToolResult> => {
        const result = await def.handler(args);
        // Result prose may also point at sibling tools (e.g. list_firms
        // suggests get_challenge_rules) — rewrite those references too.
        // Structured content is data and passes through untouched.
        return {
          ...result,
          content: result.content.map((item) =>
            item.type === "text" ? { ...item, text: rewriteToolReferences(item.text) } : item,
          ),
        } as CallToolResult;
      },
    );
  }
}

/*
  The library tools — core schemas as specified in the endpoint audit
  (docs/library-mcp-audit.md in the site repo). All read-only and
  keyless. Tool results are compact JSON in text content; every payload
  carries canonical URLs so agents can cite pages.
*/
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CONCEPT_FAMILIES,
  FAMILY_NAMES,
  type Concept,
  type ConceptFamily,
  conceptMdUrl,
  conceptUrl,
  familyMdUrl,
  familyUrl,
  fetchMarkdown,
  getConcepts,
  getIndicatorBySlug,
  getLibraryTags,
  getPineScriptCode,
  indicatorUrl,
  quantUrl,
  queryIndicators,
} from "./api.js";

const familyEnum = z.enum(CONCEPT_FAMILIES);

function json(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9%]+/).filter(Boolean);
}

/**
 * Case-insensitive match with a light rank: exact > prefix > substring >
 * token-level. The token tier matches every query word against some haystack
 * word by prefix in either direction, so near-misses like "stochastics" →
 * "Stochastic Oscillator" still hit.
 */
function rank(haystack: string, needle: string): number {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  if (h === n) return 4;
  if (h.startsWith(n)) return 3;
  if (h.includes(n)) return 2;
  const hTokens = tokenize(h);
  const nTokens = tokenize(n);
  if (
    nTokens.length > 0 &&
    nTokens.every((nt) => hTokens.some((ht) => ht.startsWith(nt) || nt.startsWith(ht)))
  ) {
    return 1;
  }
  return 0;
}

function nearestConcepts(concepts: Concept[], slug: string, limit = 3): string[] {
  return concepts
    .map((c) => ({ slug: c.slug, score: rank(c.slug, slug) + rank(c.name, slug) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((c) => c.slug);
}

export function registerLibraryTools(server: McpServer) {
  server.registerTool(
    "library_search",
    {
      title: "Search the LuxAlgo Library",
      description:
        "Search the LuxAlgo Library — the encyclopedia of trading and technical analysis. One query over 800+ concepts (alias-aware: 'stochastics' finds Stochastic Oscillator) and 800+ ready-to-use indicators. Start here whenever you have a name, informal term, or topic; results carry slugs for the get tools plus canonical URLs for citation.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "A concept, indicator name, alias, or topic — e.g. 'order blocks', 'mean reversion', 'stochastics'",
          ),
        type: z
          .enum(["all", "concepts", "indicators"])
          .optional()
          .describe(
            "Limit to 'concepts' (explanations) or 'indicators' (implementations); default all",
          ),
        family: familyEnum.optional().describe("Narrow to one concept family"),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
      },
    },
    async ({ query, type, family, limit }) => {
      const max = limit ?? 10;
      const kind = type ?? "all";
      const conceptResults: unknown[] = [];
      const indicatorResults: unknown[] = [];

      if (kind !== "indicators") {
        const concepts = await getConcepts();
        const matches = concepts
          .filter((c) => !family || c.family === family)
          .map((c) => {
            const nameScore = rank(c.name, query) * 2 + rank(c.slug, query);
            const alias = c.aliases.find((a) => rank(a, query) > 0);
            const score = nameScore + (alias ? 2 : 0);
            return { c, alias, score };
          })
          .filter((m) => m.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, max);
        for (const { c, alias } of matches) {
          conceptResults.push({
            kind: "concept",
            slug: c.slug,
            name: c.name,
            family: c.family,
            matched_alias: alias,
            url: conceptUrl(c.slug),
            md_url: conceptMdUrl(c.slug),
          });
        }
      }

      if (kind !== "concepts") {
        const { indicators } = await queryIndicators({
          text: query,
          family,
          sort: "name",
          pageIndex: 0,
          pageQuantity: max,
        });
        for (const row of indicators.slice(0, max)) {
          indicatorResults.push({
            kind: "indicator",
            slug: row.slug,
            name: row.name,
            family: row.family,
            description: row.description,
            url: indicatorUrl(row.slug),
          });
        }
      }

      // Interleave the two kinds so neither starves the other, then honor
      // the limit across the combined list (per the audited schema).
      const results: unknown[] = [];
      for (let i = 0; results.length < max; i++) {
        const concept = conceptResults[i];
        const indicator = indicatorResults[i];
        if (concept === undefined && indicator === undefined) break;
        if (concept !== undefined) results.push(concept);
        if (indicator !== undefined && results.length < max) results.push(indicator);
      }
      return json({ results });
    },
  );

  server.registerTool(
    "library_get_concept",
    {
      title: "Get a Library concept",
      description:
        "Explain a trading concept: the Library's full write-up as markdown — definition, formula, how traders read it, and its indicator implementations. Use for any 'what is X / how does X work' question. Needs the exact slug — find it with library_search or library_list_concepts.",
      inputSchema: {
        slug: z
          .string()
          .min(1)
          .describe(
            "Exact concept slug, e.g. 'rsi' or 'order-blocks' — from search or list results",
          ),
      },
    },
    async ({ slug }) => {
      const concepts = await getConcepts();
      const concept = concepts.find((c) => c.slug === slug);
      if (!concept) {
        const near = nearestConcepts(concepts, slug);
        return toolError(
          `Unknown concept slug '${slug}'.${near.length ? ` Did you mean: ${near.join(", ")}?` : ""}`,
        );
      }
      const content = await fetchMarkdown(`/library/concept/${concept.slug}.md`);
      return json({
        slug: concept.slug,
        name: concept.name,
        family: concept.family,
        cluster: concept.cluster,
        aliases: concept.aliases,
        is_fringe: concept.isFringe,
        url: conceptUrl(concept.slug),
        md_url: conceptMdUrl(concept.slug),
        content_markdown: content,
      });
    },
  );

  server.registerTool(
    "library_get_indicator",
    {
      title: "Get a Library indicator",
      description:
        "Details for one indicator: what it does, how to read it, family, concept links, preview image — plus whether its source code is available (fetch the code itself with library_get_source_code). Use when the user asks about a specific indicator.",
      inputSchema: {
        slug: z.string().min(1).describe("Indicator slug, e.g. 'tri-star'"),
      },
    },
    async ({ slug }) => {
      const result = await getIndicatorBySlug(slug);
      if (!result) return toolError(`Unknown indicator slug '${slug}'.`);
      const { indicator, pineScriptCode } = result;
      // Source is reachable either inline (by-slug) or through the keyless
      // pinescript route by id — library_get_source_code tries both.
      const available = pineScriptCode !== null || indicator.pineScriptCodeId !== null;
      return json({
        slug: indicator.slug,
        name: indicator.name,
        author: indicator.authorName,
        family: indicator.family,
        body_markdown: indicator.body,
        image_url: indicator.imageUrl,
        date_displayed: indicator.creationDateDisplayed,
        url: indicatorUrl(indicator.slug),
        ...(indicator.concepts ? { concepts: indicator.concepts } : {}),
        code: {
          available,
          ...(!available ? { reason: "no-source" } : {}),
        },
      });
    },
  );

  server.registerTool(
    "library_get_source_code",
    {
      title: "Get an indicator's source code",
      description:
        "The full, working source code of a Library indicator (works on TradingView). Kept separate from library_get_indicator because sources are long — call it only when the user wants the code itself.",
      inputSchema: {
        slug: z.string().min(1).describe("Indicator slug"),
      },
    },
    async ({ slug }) => {
      const result = await getIndicatorBySlug(slug);
      if (!result) return toolError(`Unknown indicator slug '${slug}'.`);
      const { indicator, pineScriptCode } = result;
      let source = pineScriptCode;
      if (source === null && indicator.pineScriptCodeId) {
        source = await getPineScriptCode(indicator.pineScriptCodeId);
      }
      const available = source !== null;
      return json({
        slug: indicator.slug,
        name: indicator.name,
        available,
        ...(available
          ? { source }
          : {
              reason: "runs-in-quant",
              ...(indicator.pineScriptCodeId
                ? { quant_url: quantUrl(indicator.pineScriptCodeId) }
                : {}),
            }),
      });
    },
  );

  server.registerTool(
    "library_list_concepts",
    {
      title: "List Library concepts",
      description:
        "Browse every trading and technical-analysis concept in the Library — paginated, optionally one family. Use to enumerate a topic area or find slugs for library_get_concept; for keyword lookup prefer library_search.",
      inputSchema: {
        family: familyEnum.optional(),
        page: z.number().int().min(0).optional().describe("Default 0"),
        page_size: z.number().int().min(1).max(200).optional().describe("Default 50"),
      },
    },
    async ({ family, page, page_size }) => {
      const concepts = await getConcepts();
      const filtered = family ? concepts.filter((c) => c.family === family) : concepts;
      const size = page_size ?? 50;
      const start = (page ?? 0) * size;
      return json({
        total: filtered.length,
        page: page ?? 0,
        page_size: size,
        concepts: filtered.slice(start, start + size).map((c) => ({
          slug: c.slug,
          name: c.name,
          family: c.family,
          cluster: c.cluster,
          aliases: c.aliases,
          url: conceptUrl(c.slug),
        })),
      });
    },
  );

  server.registerTool(
    "library_list_indicators",
    {
      title: "List Library indicators",
      description:
        "Browse the indicator catalog with filters and server-side sorting (newest first by default). Filter by family, concept slug (implementations of one concept), tags (ids from library_list_tags, AND-combined), trading platform, or plan tier. Use for structured browsing — 'latest indicators', 'everything in the volatility family', 'indicators implementing liquidity sweeps'; for keyword discovery prefer library_search.",
      inputSchema: {
        family: familyEnum.optional(),
        text: z.string().optional().describe("Server-side text filter"),
        concept: z
          .string()
          .optional()
          .describe("Concept slug — only indicators linked to this concept, e.g. 'rsi'"),
        tags: z
          .array(z.string())
          .optional()
          .describe("Tag ids (from library_list_tags); an indicator must carry every tag"),
        platform: z
          .string()
          .optional()
          .describe("Trading platform the indicator supports, e.g. 'metatrader'"),
        tier: z
          .enum(["essential", "premium", "ultimate", "ultra"])
          .optional()
          .describe("Only indicators included in this LuxAlgo plan tier"),
        sort: z.enum(["name", "date", "family"]).optional().describe("Default: date"),
        direction: z.enum(["asc", "desc"]).optional(),
        page: z.number().int().min(0).optional().describe("Default 0"),
        page_size: z.number().int().min(1).max(100).optional().describe("Default 24"),
      },
    },
    async ({ family, text, concept, tags, platform, tier, sort, direction, page, page_size }) => {
      const sortKey =
        sort === "date" || sort === undefined ? "creationDateDisplayed" : sort;
      const { indicators, count } = await queryIndicators({
        family,
        text,
        concept,
        tags,
        platform,
        tier,
        sort: sortKey,
        direction,
        pageIndex: page ?? 0,
        pageQuantity: page_size ?? 24,
      });
      return json({
        total: count,
        page: page ?? 0,
        page_size: page_size ?? 24,
        indicators: indicators.map((row) => ({
          slug: row.slug,
          name: row.name,
          family: row.family,
          description: row.description,
          tags: (row.tags ?? []).map((tag) => tag.name),
          image_url: row.imageUrl,
          date_displayed: row.creationDateDisplayed,
          url: indicatorUrl(row.slug),
        })),
      });
    },
  );

  server.registerTool(
    "library_list_tags",
    {
      title: "List indicator tags",
      description:
        "The Library's indicator tag vocabulary (behavioral traits like 'Volatility', 'Trailing-Stop', 'Repainting Functionality'). Returns ids to pass as the tags filter of library_list_indicators — tags are orthogonal to the concept-family taxonomy.",
      inputSchema: {},
    },
    async () => {
      const tags = await getLibraryTags();
      return json({
        tags: tags.map((tag) => ({ id: tag.id, name: tag.name })),
      });
    },
  );

  server.registerTool(
    "library_list_families",
    {
      title: "List concept families",
      description:
        "The Library's top-level taxonomy: 17 families of trading concepts (trend, momentum, SMC/ICT, statistics, …) with concept counts and hub links. The natural first call for orientation.",
      inputSchema: {},
    },
    async () => {
      const concepts = await getConcepts();
      const counts = new Map<ConceptFamily, number>();
      for (const c of concepts) counts.set(c.family, (counts.get(c.family) ?? 0) + 1);
      return json({
        families: CONCEPT_FAMILIES.map((key) => ({
          key,
          name: FAMILY_NAMES[key],
          concept_count: counts.get(key) ?? 0,
          url: familyUrl(key),
          md_url: familyMdUrl(key),
        })),
      });
    },
  );

  server.registerTool(
    "library_get_family",
    {
      title: "Get a family hub",
      description:
        "A family's hub page as markdown — the written overview of that school of analysis plus its complete concept roster. Use after library_list_families, or when the user asks about a whole area like 'SMC' or 'Wyckoff'.",
      inputSchema: {
        key: familyEnum.describe("Family key, e.g. 'smc-ict'"),
      },
    },
    async ({ key }) => {
      const [content, concepts] = await Promise.all([
        fetchMarkdown(`/library/family/${key}.md`),
        getConcepts(),
      ]);
      return json({
        key,
        name: FAMILY_NAMES[key],
        url: familyUrl(key),
        md_url: familyMdUrl(key),
        content_markdown: content,
        concepts: concepts
          .filter((c) => c.family === key)
          .map((c) => ({ slug: c.slug, name: c.name, cluster: c.cluster })),
      });
    },
  );
}

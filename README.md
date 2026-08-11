# LuxAlgo Library MCP

The [LuxAlgo Library](https://www.luxalgo.com/library/) — the encyclopedia of
trading & technical analysis — as an MCP server. Hundreds of concepts with
formulas and plain-markdown pages, and the full indicator catalog with
descriptions, families, and Pine Script sources where publicly served.
**Free, keyless, read-only.**

## Install

**Hosted (recommended)** — point any MCP client at:

```
https://mcp.luxalgo.com/mcp
```

Claude Code:

```bash
claude mcp add --transport http luxalgo https://mcp.luxalgo.com/mcp
```

Cursor (`.cursor/mcp.json`) / Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "luxalgo": { "url": "https://mcp.luxalgo.com/mcp" }
  }
}
```

**Local (stdio)**:

```json
{
  "mcpServers": {
    "luxalgo": { "command": "npx", "args": ["-y", "@luxalgo/mcp"] }
  }
}
```

## Tools

| Tool | What it does |
| --- | --- |
| `library_search` | One search over concepts (alias-aware) + indicators |
| `library_get_concept` | Full concept page as markdown |
| `library_get_indicator` | Indicator detail: body, family, concepts, source code availability |
| `library_get_source_code` | Full source code when publicly served (own tool — fetched only on demand) |
| `library_list_concepts` | Paginated concept roster, optionally per family |
| `library_list_indicators` | Filtered, paginated browse with server-side sort |
| `library_list_families` | The taxonomy backbone with counts |
| `library_get_family` | A family hub as markdown + concept roster |

All outputs are compact JSON with canonical `url`s for citation. Concept and
family pages are also directly fetchable as markdown — append `.md` to any
concept URL.

## Development

```bash
npm install
npm run build
npm start            # stdio
npm run start:http   # streamable HTTP on :3333/mcp
npm test             # smoke suite over stdio (hits live endpoints)
```

Environment (optional): `LUXALGO_APP_ORIGIN`, `LUXALGO_SITE_ORIGIN` to point
at non-production environments.

## Deployment

Two hosted options, same tools either way:

- **Any Node 20+ host** (container, VPS, Railway, Fly, …): run
  `node dist/http.js` (`PORT` env, defaults to 3333). Stateless — scales
  horizontally.
- **Vercel**: `api/server.ts` wraps the same tools with
  [`mcp-handler`](https://github.com/vercel/mcp-handler); `vercel.json`
  rewrites all paths to it, so clients still connect to `/mcp`. Import the
  repo in Vercel with framework preset **Other** — no build settings needed.
  Test the Vercel code path locally with
  `node scripts/vercel-smoke.mjs` + `node scripts/smoke.mjs --http
  http://localhost:3334/mcp`.

## License

MIT © LuxAlgo

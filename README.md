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
| `library_get_indicator` | Indicator detail: body, family, concepts, Pine availability |
| `library_get_pine_source` | Full Pine source when publicly served (own tool — fetched only on demand) |
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
```

Environment (optional): `LUXALGO_APP_ORIGIN`, `LUXALGO_SITE_ORIGIN` to point
at non-production environments.

## License

MIT © LuxAlgo

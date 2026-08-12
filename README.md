<h1 align="center">
  LuxAlgo Library MCP
</h1>

<p align="center">
  <a href="https://cursor.com/en/install-mcp?name=luxalgo&config=eyJ1cmwiOiJodHRwczovL21jcC5sdXhhbGdvLmNvbS9tY3AifQ=="><img src="https://custom-icon-badges.demolab.com/badge/Install_in_Cursor-000000?style=for-the-badge&logo=cursor-ai-white" alt="Install in Cursor" /></a>
  <a href="https://vscode.dev/redirect/mcp/install?name=luxalgo&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.luxalgo.com%2Fmcp%22%7D"><img src="https://custom-icon-badges.demolab.com/badge/Install_in_VS_Code-007ACC?style=for-the-badge&logo=vsc&logoColor=white" alt="Install in VS Code" /></a>
</p>

<p align="center">
  <a href="https://www.luxalgo.com/library/"><b>Library</b></a>
  &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/package/@luxalgo/mcp"><b>NPM Package</b></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/LuxAlgo/luxalgo-mcp-server"><b>GitHub</b></a>
</p>

The [LuxAlgo Library](https://www.luxalgo.com/library/) — The encyclopedia of trading &amp; technical analysis — as an MCP server. Hundreds of concepts with formulas and plain-markdown pages, plus the full indicator catalog with descriptions, families, and Pine Script sources where publicly served. Free, keyless, read-only.

## Installation

Connect to the hosted MCP server:

```
https://mcp.luxalgo.com/mcp
```

### Claude Code

```bash
claude mcp add --transport http luxalgo https://mcp.luxalgo.com/mcp
```

### Cursor

Use the **Install in Cursor** badge above, or add this to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "luxalgo": {
      "url": "https://mcp.luxalgo.com/mcp"
    }
  }
}
```

### Other MCP Clients

Add the hosted URL to your client's MCP config:

```json
{
  "mcpServers": {
    "luxalgo": {
      "url": "https://mcp.luxalgo.com/mcp"
    }
  }
}
```

<details>
<summary><b>Client-specific configs</b></summary>

| Client | Where to add it |
| --- | --- |
| Cursor | `.cursor/mcp.json` or the install badge above |
| Claude Desktop | `claude_desktop_config.json` |
| VS Code | Install badge above, or MCP settings |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Zed | `settings.json` under `context_servers` |
| Warp | [Settings → Agents → MCP servers](warp://settings/mcp) |
| LM Studio | `mcp.json` |
| OpenCode | `opencode.json` |
| Gemini CLI | `~/.gemini/settings.json` |

</details>

### Local (stdio)

```json
{
  "mcpServers": {
    "luxalgo": {
      "command": "npx",
      "args": ["-y", "@luxalgo/mcp"]
    }
  }
}
```

## Available Tools

| Tool | Description |
| --- | --- |
| `library_search` | One search over concepts (alias-aware) + indicators |
| `library_get_concept` | Full concept page as markdown |
| `library_get_indicator` | Indicator detail: body, family, concepts, source code availability |
| `library_get_source_code` | Full source code when publicly served (fetched only on demand) |
| `library_list_concepts` | Paginated concept roster, optionally per family |
| `library_list_indicators` | Filtered, paginated browse with server-side sort |
| `library_list_families` | The taxonomy backbone with counts |
| `library_get_family` | A family hub as markdown + concept roster |

All outputs are compact JSON with canonical `url`s for citation. Concept and family pages are also directly fetchable as markdown — append `.md` to any concept URL.

## Development

```bash
npm install
npm run build
npm start            # stdio
npm run start:http   # streamable HTTP on :3333/mcp
npm test             # smoke suite over stdio (hits live endpoints)
```

Environment (optional): `LUXALGO_APP_ORIGIN`, `LUXALGO_SITE_ORIGIN` to point at non-production environments.

## License

MIT © LuxAlgo

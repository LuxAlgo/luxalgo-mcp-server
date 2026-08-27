<h1 align="center">
  LuxAlgo MCP
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

The LuxAlgo ecosystem as an MCP server. Free, keyless, read-only.

## What's covered

- **[Library](https://www.luxalgo.com/library/)** — The encyclopedia of trading &amp; technical analysis. Hundreds of concepts with formulas and plain-markdown pages, plus the full indicator catalog with descriptions, families, and Pine Script sources where publicly served.
- **Prop Firms** — LuxAlgo's prop-firm analysis catalog. Search proprietary trading firms, funded-account challenges with their full rulebooks (account size, fees, steps, profit split, drawdown modes, trading restrictions), and live offers with promo codes and discounts.
- **Challenge Simulator** — the open-source [prop-firm-sim](https://github.com/LuxAlgo/prop-firm-sim) Monte Carlo engine (via the [`@luxalgo/prop-firm-sim-core`](https://www.npmjs.com/package/@luxalgo/prop-firm-sim-core) and [`@luxalgo/prop-firm-sim-mcp`](https://www.npmjs.com/package/@luxalgo/prop-firm-sim-mcp) npm packages), running locally in the server: your stats or your real R-multiple trade series through a firm's exact ruleset — pass probability with confidence intervals, expected attempts and cost, EV over the funded horizon, optimal risk sweeps, cross-challenge comparison, and reference-archetype odds. Deterministic under seed; every assumption disclosed.
- **More to come** — new LuxAlgo ecosystem areas will land here as they open up.

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

### Library

| Tool | Description |
| --- | --- |
| `library_search` | One search over concepts (alias-aware) + indicators |
| `library_get_concept` | Full concept page as markdown |
| `library_get_indicator` | Indicator detail: body, family, concepts, source code availability |
| `library_get_source_code` | Full source code when publicly served (fetched only on demand) |
| `library_list_concepts` | Paginated concept roster, optionally per family |
| `library_list_indicators` | Filtered, paginated browse (family, concept, tags, platform, tier) with server-side sort |
| `library_list_tags` | The indicator tag vocabulary, for the tags filter |
| `library_list_families` | The taxonomy backbone with counts |
| `library_get_family` | A family hub as markdown + concept roster |

Library outputs are compact JSON with canonical `url`s for citation. Concept and family pages are also directly fetchable as markdown — append `.md` to any concept URL.

### Prop Firms

| Tool | Description |
| --- | --- |
| `propfirms_search` | Search firms — firm filters (platforms, markets, payments, Trustpilot, country availability) composable with nested challenge/offer filters; `include` nests matching children |
| `propfirms_get` | One firm's full dossier: profile, every challenge, live offers, written overview |
| `propfirms_search_challenges` | Search challenges by rules (size, fee, steps, profit split, drawdown, trading restrictions) and parent firm; can attach applicable live offers |
| `propfirms_search_offers` | Search live discounts/promo codes; resolvable per firm or per challenge |

### Challenge Simulator

| Tool | Description |
| --- | --- |
| `propfirms_list_simulatable` | Every simulatable firm + challenge in the live directory, provenance-disclosed |
| `propfirms_challenge_rules` | One challenge's full encoded ruleset (drawdown modes, consistency, payout gating, citations) — editable and re-simulatable inline |
| `propfirms_simulate` | Monte Carlo of your stats (win rate, avg win, trades/day, risk sizing) through a firm's exact ruleset + funded horizon: pass probability with CI, which rule kills attempts, expected attempts/cost, EV, payout probability |
| `propfirms_simulate_trades` | Same, from your real R-multiple trade series — block bootstrap preserves your streaks |
| `propfirms_optimal_risk` | Risk sweep: pass-optimal vs EV-optimal risk per trade (they differ) |
| `propfirms_compare` | Same trader across up to 12 challenges, EV-sorted (not a ranking) |
| `propfirms_pass_rates` | The site's reference-archetype odds, recomputed live (seed 42, 10k paths) |
| `propfirms_validate_strategy` | Screen one strategy across every simulatable challenge against an explicit pass bar |

Every simulation result carries its assumptions, unsimulated-rule flags, seed, and engine version — distributions under stated assumptions, never promises. The engine runs locally; firm rules adapt live from the directory (inline specs simulate fully offline).

## Development

```bash
npm install
npm run build
npm start            # stdio
npm run start:http   # streamable HTTP on :3333/mcp
npm test             # smoke suite over stdio (hits live endpoints)
npm run test:parity  # simulator tools vs upstream package + raw engine (run after sim-* bumps)
```

Environment (optional): `LUXALGO_APP_ORIGIN`, `LUXALGO_SITE_ORIGIN` to point at non-production environments.

## License

MIT © LuxAlgo

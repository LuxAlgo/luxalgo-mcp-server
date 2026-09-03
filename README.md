<img alt="LuxAlgo MCP" src=".github/assets/banner.svg" width="100%">

<div align="center">

<a href="https://cursor.com/en/install-mcp?name=luxalgo&config=eyJ1cmwiOiJodHRwczovL21jcC5sdXhhbGdvLmNvbS9tY3AifQ=="><img src="https://custom-icon-badges.demolab.com/badge/Install_in_Cursor-0a0a0a?style=for-the-badge&logo=cursor-ai-white" alt="Install in Cursor" /></a>&nbsp;<a href="https://vscode.dev/redirect/mcp/install?name=luxalgo&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.luxalgo.com%2Fmcp%22%7D"><img src="https://custom-icon-badges.demolab.com/badge/Install_in_VS_Code-0a0a0a?style=for-the-badge&logo=vsc" alt="Install in VS Code" /></a>

[![CI](https://img.shields.io/github/actions/workflow/status/LuxAlgo/luxalgo-mcp-server/ci.yml?branch=main&style=flat-square&label=ci&labelColor=0a0a0a)](https://github.com/LuxAlgo/luxalgo-mcp-server/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@luxalgo/mcp?style=flat-square&label=npm&labelColor=0a0a0a&color=35a2de)](https://www.npmjs.com/package/@luxalgo/mcp)
[![license](https://img.shields.io/npm/l/@luxalgo/mcp?style=flat-square&labelColor=0a0a0a&color=9200ff)](LICENSE)

[Library](https://www.luxalgo.com/library/) · [Brokers](https://github.com/LuxAlgo/broker-sdk) · [Edge Stats](https://github.com/LuxAlgo/edge-stats) · [Market Trackers](https://github.com/LuxAlgo/market-trackers) · [Challenge Simulator](https://github.com/LuxAlgo/prop-firm-sim) · [Prop Firms](https://www.luxalgo.com/prop-firms/) · [npm](https://www.npmjs.com/package/@luxalgo/mcp) · [Endpoint](https://mcp.luxalgo.com/mcp)

</div>

**LuxAlgo MCP** is a LuxAlgo open-source project. Official repository: [github.com/LuxAlgo/luxalgo-mcp-server](https://github.com/LuxAlgo/luxalgo-mcp-server).

It puts the LuxAlgo ecosystem behind a single MCP server: an encyclopedia of trading and technical analysis, read-only access to your own brokerage accounts, hosted session statistics with a sample size on every number, the public record of US markets (congressional trades, insider filings, lobbying, contracts, patents and more, with a primary-source link on every row), a Monte Carlo challenge simulator, and a live prop-firm directory. Free and read-only. No API key for anything hosted; the local broker tools use your own keys and never send them anywhere.

```bash
claude mcp add --transport http luxalgo https://mcp.luxalgo.com/mcp
```

## What's inside

| Area | What you get |
| --- | --- |
| **[Library](https://www.luxalgo.com/library/)** | The encyclopedia of trading and technical analysis: hundreds of concept pages with formulas, the full indicator catalog with families and tags, and Pine Script sources where publicly served. |
| **Brokers** (local only) | Read-only access to your own accounts across 16 brokers and exchanges via [broker-sdk](https://github.com/LuxAlgo/broker-sdk): balances, positions, trade history, FIFO performance stats. Keys live in your MCP client config as env vars and never leave your machine. The hosted endpoint does not carry these tools, on purpose. |
| **Edge Stats** | Hosted session statistics from the open-source [edge-stats](https://github.com/LuxAlgo/edge-stats) engine: how often a setup actually worked (gap fills, opening-range breakouts, day-of-week effects, event days) with the sample size and a Wilson 95% confidence interval on every number. A nightly build runs the real engine over free market data and publishes only derived statistics; these tools serve them verbatim. |
| **[Market Trackers](https://github.com/LuxAlgo/market-trackers)** | The public record of US markets from primary sources only: congressional trades, insider (Forms 3/4/5) transactions, 13F holdings, federal contracts and grants, lobbying filings, FINRA short-sale volume, granted patents, clinical trials, FDA drug events, CFTC positioning, federal bills, FEC campaign finance, hearing transcripts, Federal Reserve communications, committee assignments, Wikipedia pageviews. Read straight from the pipeline's [CC0 dumps](https://github.com/LuxAlgo/market-trackers-data) — live tree plus deep-history archives — with `provenance.sourceUrl` on every row. Data only: no signals, scores, or predictions. |
| **Challenge Simulator** | The open-source [prop-firm-sim](https://github.com/LuxAlgo/prop-firm-sim) Monte Carlo engine, running locally inside the server. Your stats, or your real R-multiple trade series, through a firm's exact ruleset: pass probability with confidence intervals, expected attempts and cost, EV over the funded horizon, optimal-risk sweeps, cross-challenge comparison. Deterministic under seed, every assumption disclosed. |
| **Prop Firm Directory** | The live data the simulator draws from: firms, funded-account challenges with their full rulebooks (account sizes, fees, steps, profit splits, drawdown modes, trading restrictions), and current offers. |

## Install

The hosted server is one URL:

```
https://mcp.luxalgo.com/mcp
```

### Claude Code

```bash
claude mcp add --transport http luxalgo https://mcp.luxalgo.com/mcp
```

### Cursor

Use the **Install in Cursor** button above, or add this to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "luxalgo": {
      "url": "https://mcp.luxalgo.com/mcp"
    }
  }
}
```

### Any other MCP client

Point your client's MCP config at the hosted URL:

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
<summary><b>Where each client keeps its config</b></summary>
<br>

| Client | Where to add it |
| --- | --- |
| Cursor | `.cursor/mcp.json`, or the install button above |
| Claude Desktop | `claude_desktop_config.json` |
| VS Code | Install button above, or MCP settings |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Zed | `settings.json` under `context_servers` |
| Warp | Settings → Agents → MCP servers |
| LM Studio | `mcp.json` |
| OpenCode | `opencode.json` |
| Gemini CLI | `~/.gemini/settings.json` |

</details>

### Local (stdio)

Runs every hosted tool locally, and unlocks the broker tools. Set read-only credential env vars for the brokers you use. Any subset works: a broker connects when all of its vars are set, and with no vars at all the broker tools simply stay unconfigured.

```json
{
  "mcpServers": {
    "luxalgo": {
      "command": "npx",
      "args": ["-y", "@luxalgo/mcp"],
      "env": {
        "BROKERS_ALPACA_API_KEY": "…",
        "BROKERS_ALPACA_API_SECRET": "…",
        "BROKERS_KRAKEN_API_KEY": "…",
        "BROKERS_KRAKEN_API_SECRET": "…",
        "BROKERS_HYPERLIQUID_WALLET_ADDRESS": "0x…"
      }
    }
  }
}
```

Env var names derive from each broker's credential fields: `BROKERS_<BROKER>_<FIELD>` (for example `BROKERS_OKX_PASSPHRASE`, `BROKERS_IBKR_FLEX_FLEX_TOKEN`). The `broker_setup` tool lists every supported broker, its exact variables, and a one-line guide to creating each key with read-only scope, which is all this server ever needs.

## Tools

### Library

| Tool | Description |
| --- | --- |
| `library_search` | One search over concepts (alias-aware) and indicators |
| `library_get_concept` | Full concept page as markdown |
| `library_get_indicator` | Indicator detail: body, family, concepts, source code availability |
| `library_get_source_code` | Full source code when publicly served, fetched only on demand |
| `library_list_concepts` | Paginated concept roster, optionally per family |
| `library_list_indicators` | Filtered, paginated browse (family, concept, tags, platform, tier) with server-side sort |
| `library_list_tags` | The indicator tag vocabulary, for the tags filter |
| `library_list_families` | The taxonomy backbone with counts |
| `library_get_family` | A family hub as markdown plus concept roster |

Library outputs are compact JSON with canonical `url`s for citation. Concept and family pages are also directly fetchable as markdown: append `.md` to any concept URL.

### Brokers (local stdio only)

| Tool | Description |
| --- | --- |
| `broker_setup` | Supported brokers, their env vars (set or unset, never values), read-only key guides |
| `broker_accounts` | Connected accounts: broker, currency, equity, cash |
| `broker_positions` | Open positions with market values, asset class, entry price; negative quantity means short |
| `broker_trades` | Trade history, newest first; filter by broker or symbol |
| `broker_stats` | Total equity, equity by broker, top positions, FIFO win rate and realized PnL |
| `broker_refresh` | Bypass the 5-minute cache and re-fetch now |

Read-only by construction: the SDK's root export has no trading endpoints, the server never writes secrets anywhere, and per-broker failures are reported alongside results, never silently dropped.

### Edge Stats

Hosted session statistics from the open-source [edge-stats](https://github.com/LuxAlgo/edge-stats) engine, precomputed nightly:

| Tool | Description |
| --- | --- |
| `edge_symbols` | What the hosted store covers: symbols, session calendars, coverage windows, last build |
| `edge_presets` | The catalog of precomputed questions, each stating in plain language what its number means |
| `edge_report` | One result in the engine's full honesty envelope: estimate, N, Wilson 95% CI, minimum-sample guards, stability split, per-year counts, distribution, disclaimer |

Every number arrives with its sample size — the engine has no code path that returns a percentage without one. Results are historical conditional frequencies, never predictions. For arbitrary composed queries or your own market data, run edge-stats locally; its own MCP server exposes the full engine over your local store.

### Market Trackers

| Tool | Description |
| --- | --- |
| `trackers_datasets` | The catalog: every dataset's row count, freshness, years with data (live vs deep-history archive), ticker-searchability; pass `dataset` for its field roster, filterable paths, caveats, per-year coverage, source health and dump URLs |
| `trackers_query` | Search one dataset by ticker, free text, exact field values (`where`, dot paths) and event-date range, choosing which years to read; newest/oldest ordering with paging |
| `trackers_latest` | The newest daily delta of a dataset (today's insider filings, this week's congressional disclosures), optionally narrowed by ticker or text |
| `trackers_ticker` | One ticker across every ticker-bearing dataset for a year: per-dataset counts with the newest rows — a public-record dossier |

The data is the CC0 output of [LuxAlgo/market-trackers](https://github.com/LuxAlgo/market-trackers), published daily to [LuxAlgo/market-trackers-data](https://github.com/LuxAlgo/market-trackers-data): year-sharded gzipped JSON in the repository's live tree, plus deep-history shards attached to the data repo's GitHub Releases and indexed in its `archives.json`. The server streams shards row by row (never loading a whole file) under a per-call budget of compressed bytes, so a deep-history year (often 30–60 MB compressed) is read one at a time. Amounts disclosed as ranges stay ranges; ticker mappings for contracts, lobbying, trials, FDA events and patents are best-effort against a curated map of public companies; every row keeps its primary-source deep link.

### Challenge Simulator

Runs locally inside the server:

| Tool | Description |
| --- | --- |
| `propfirms_list_simulatable` | Every simulatable firm and challenge in the live directory, provenance-disclosed |
| `propfirms_challenge_rules` | One challenge's full encoded ruleset (drawdown modes, consistency, payout gating, citations), editable and re-simulatable inline |
| `propfirms_simulate` | Monte Carlo of your stats (win rate, avg win, trades/day, risk sizing) through a firm's exact ruleset and funded horizon: pass probability with CI, which rule kills attempts, expected attempts and cost, EV, payout probability |
| `propfirms_simulate_trades` | Same, from your real R-multiple trade series; block bootstrap preserves your streaks |
| `propfirms_optimal_risk` | Risk sweep: pass-optimal vs EV-optimal risk per trade (they differ) |
| `propfirms_compare` | Same trader across up to 12 challenges, EV-sorted (not a ranking) |
| `propfirms_pass_rates` | The site's reference-archetype odds, recomputed live (seed 42, 10k paths) |
| `propfirms_validate_strategy` | Screen one strategy across every simulatable challenge against an explicit pass bar |

Every simulation result carries its assumptions, unsimulated-rule flags, seed, and engine version. Results are distributions under stated assumptions, never promises. The engine runs locally; firm rules adapt live from the directory, and inline specs simulate fully offline.

### Prop Firm Directory

The live directory the simulator draws from, queryable directly:

| Tool | Description |
| --- | --- |
| `propfirms_search` | Search firms; firm filters (platforms, markets, payments, Trustpilot, country availability) compose with nested challenge and offer filters, and `include` nests matching children |
| `propfirms_get` | One firm's full dossier: profile, every challenge, live offers, written overview |
| `propfirms_search_challenges` | Search challenges by rules (size, fee, steps, profit split, drawdown, trading restrictions) and parent firm; can attach applicable live offers |
| `propfirms_search_offers` | Current discounts and promo codes, resolvable per firm or per challenge |

## Development

```bash
npm install
npm run build
npm start            # stdio
npm run start:http   # streamable HTTP on :3333/mcp
npm test               # smoke suite over stdio (hits live endpoints)
npm run test:parity    # simulator tools vs upstream package + raw engine
npm run test:trackers  # offline checks of the Market Trackers streaming engine
```

Optional env: `LUXALGO_APP_ORIGIN` and `LUXALGO_SITE_ORIGIN` point the server at non-production environments; `MARKET_TRACKERS_DUMPS_ORIGIN` (default `https://raw.githubusercontent.com/LuxAlgo/market-trackers-data/main`) and `MARKET_TRACKERS_DATA_REPO` point the Market Trackers tools at another dumps tree.

## Disclaimer

Nothing this server returns is investment advice. Simulation outputs are modeled estimates under stated assumptions, not predictions or guarantees. Verify balances and performance numbers against your broker's own statements, and a prop firm's own page is authoritative for its current rules.

## License

Code is [MIT](LICENSE) © LuxAlgo Global, LLC. Library content and Pine Script sources served by this server keep their own licenses; see [NOTICE](NOTICE).

The LuxAlgo name and logo are trademarks of LuxAlgo Global, LLC; see [TRADEMARKS.md](TRADEMARKS.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

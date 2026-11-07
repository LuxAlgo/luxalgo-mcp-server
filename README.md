<a href="https://mcp.luxalgo.com">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/cover-dark.png">
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/cover-light.png">
    <img alt="Vela, in ChatGPT, Claude and any agent. Vela by LuxAlgo." src=".github/assets/cover-dark.png" width="100%">
  </picture>
</a>

# LuxAlgo MCP

**Vela, live in your chat.** Ask for a chart and it opens right in the conversation: a live chart from [Vela](https://vela.luxalgo.com/chart), the next-generation charting platform by LuxAlgo, that changes when you ask. Sign in with LuxAlgo and your AI works inside your own Vela too.

[![npm](https://img.shields.io/npm/v/@luxalgo/mcp?style=flat-square&label=npm&labelColor=0a0a0a&color=35a2de)](https://www.npmjs.com/package/@luxalgo/mcp)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.LuxAlgo%2Fluxalgo--mcp--server-9200ff?style=flat-square&labelColor=0a0a0a)](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.LuxAlgo/luxalgo-mcp-server)
[![License: MIT](https://img.shields.io/badge/license-MIT-ededed?style=flat-square&labelColor=0a0a0a)](LICENSE)

## Right here in your chat

<img alt="A live BTC 4 hour Vela chart with RSI and a level at 80,000, opened from one sentence inside a chat" src="docs/images/vela-chart-in-chat.png" width="100%">

- **Open a live chart from a sentence.** "Show BTC on 4 hour candles with RSI and a line at 80,000." It runs on the open-source core of Vela by LuxAlgo.
- **Change it by asking.** Switch markets, add RSI or MACD, draw a level, shade a zone, zoom to a date range. The chart updates in place.
- **Your AI reads it.** The last price, the day's change and each indicator's latest value, as you see them.
- **Crypto and 24/7 stocks.** Crypto from Hyperliquid and Binance, and Hyperliquid's 24/7 stock perpetuals such as TSLA. **Open in Vela** takes the chart to the full platform.
- **The Library.** 800+ indicators and 800+ concepts, with Pine Script® source where it is published and a link that opens each indicator on a Vela chart.
- **Session statistics.** Gap fills, opening-range breakouts, weekday effects, each with its sample size and a 95% confidence interval: historical frequencies, never predictions.
- **Prop firm simulations.** Your stats or real trades through a firm's exact rules: the chance you pass, the likely cost and the rule that ends most attempts.

The chart shows in clients that display MCP Apps (ChatGPT today).

## Inside your Vela

Sign in with LuxAlgo and your AI works in your own Vela:

- builds and edits your **watchlists**;
- pulls up your **saved layouts**;
- looks at **the chart you have open**;
- reviews, logs and tags **your trades** in your Trade Journal.

It never places trades, moves money or gives investment advice.

## Add it

| Where | How | What you get |
| --- | --- | --- |
| **ChatGPT** | The approved LuxAlgo app: open **Plugins** in ChatGPT, search **LuxAlgo**, add it. | Everything above |
| **Claude** | **Customize** > **Connectors** > **+** > **Add custom connector**: `https://claude.mcp.luxalgo.com/mcp` | The Library, prop firm simulations, session statistics and your Trade Journal; no chart or Vela account tools on this address yet |
| **Claude Code** | `claude mcp add --transport http luxalgo https://mcp.luxalgo.com/mcp` | Everything above |
| **Codex** | `codex mcp add luxalgo --url https://mcp.luxalgo.com/mcp` | Everything above |
| **Cursor, VS Code, any client** | `https://mcp.luxalgo.com/mcp` ([Cursor](https://cursor.com/en/install-mcp?name=luxalgo&config=eyJ1cmwiOiJodHRwczovL21jcC5sdXhhbGdvLmNvbS9tY3AifQ==) · [VS Code](https://vscode.dev/redirect/mcp/install?name=luxalgo&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.luxalgo.com%2Fmcp%22%7D) one-click) | Everything above; the chart where the client shows MCP Apps |
| **Your machine** | `npx -y @luxalgo/mcp` ([setup](docs/self-hosting.md#local-stdio)) | The Library, session statistics, prop firm simulations and your Trade Journal, plus read-only broker accounts; keys stay on your machine |

No API key. Signing in with LuxAlgo is asked only for your own data: your Vela and your Trade Journal.

## Build your own Vela

The chart is Vela's open-source core: [`@luxalgo/vela`](https://www.npmjs.com/package/@luxalgo/vela), a WebGL2 charting library under Apache-2.0. Docs at [velacharts.dev](https://velacharts.dev), code at [github.com/LuxAlgo/Vela](https://github.com/LuxAlgo/Vela). Pair it with `library_get_source_code` to run any published Library indicator on your own chart.

<details>
<summary><b>A Library indicator on your own chart, in two script tags</b></summary>
<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/vela-supertrend-dark.png">
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/vela-supertrend-light.png">
  <img alt="The Library's SuperTrend indicator, fetched through library_get_source_code, running on a Vela chart" src=".github/assets/vela-supertrend-dark.png" width="100%">
</picture>

<sub>The Library's <a href="https://www.luxalgo.com/library/indicator/supertrend/">SuperTrend</a> source as returned by <code>library_get_source_code</code>, executed by <code>@luxalgo/vela-pinets</code> on a <code>@luxalgo/vela</code> 0.6 chart in headless Chromium. The bars are a labelled synthetic sample.</sub>

`source` is the `source` field of a `library_get_source_code` result:

```html
<div id="chart" style="height: 480px"></div>
<script src="https://cdn.jsdelivr.net/npm/@luxalgo/vela@0.6.15/dist/vela.global.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@luxalgo/vela-pinets@0.2.10/dist/vela-pinets.global.min.js"></script>
<script>
  const chart = new Vela.Vela('#chart', { data: bars, timeframe: '1D', theme: 'dark' }); // bars: [{ time, open, high, low, close, volume? }]
  chart.registerEngine('pine', new VelaPinets.PineEngine());
  chart.addIndicator(source);
</script>
```

With a bundler: `import { Vela } from '@luxalgo/vela'` and `import { PineEngine } from '@luxalgo/vela-pinets'`; see the [quickstart](https://github.com/LuxAlgo/Vela/blob/main/docs/user/quickstart.md). Pine Script® runs through [PineTS](https://github.com/LuxAlgo/PineTS), our open-source runtime (AGPL-3.0, licensed separately). Vela's attribution mark stays on unless you show equivalent attribution next to the chart; see its [NOTICE](https://github.com/LuxAlgo/Vela/blob/main/NOTICE).

</details>

## Reference

- **[Every tool](docs/tools.md)**, by area, with example asks and which address serves what.
- **[Run it yourself](docs/self-hosting.md)**: the live charts, stdio with broker keys, Docker, HTTP, environment variables, architecture.
- **[Sign-in and privacy](docs/auth.md)**: OAuth 2.1 with the LuxAlgo app. This server holds no plan checks; the app decides what your account can see, exactly as on the web.
- **[Changelog](CHANGELOG.md)** · **[Security](SECURITY.md)**

<details>
<summary><b>Contributing</b></summary>
<br>

```bash
npm install
npm run typecheck && npm run build
npm test                 # smoke suite over stdio (live endpoints); --only library,edge for a subset
npm run test:http        # the same suite against a running HTTP entry
npm run test:parity      # simulator tools against the upstream engine
npm run test:trackers    # offline checks of the Market Trackers engine
```

Adding a tool: read [AGENTS.md](AGENTS.md) and [docs/auth.md](docs/auth.md) first. Pull requests target `dev`; commits are signed off (`git commit -s`, checked by CI).

</details>

## License

Code is [MIT](LICENSE) © LuxAlgo Global, LLC. Library content and Pine Script® sources keep their own licenses; see [NOTICE](NOTICE). LuxAlgo and Vela are trademarks of LuxAlgo Global, LLC; see [TRADEMARKS.md](TRADEMARKS.md). Nothing this server returns is investment advice: simulations are modeled estimates and statistics are historical frequencies, and a prop firm's own page is authoritative for its current rules.

<div align="center">
<br>
<b>LuxAlgo, makers of Vela.</b><br>
<a href="https://www.luxalgo.com">luxalgo.com</a> · <a href="https://vela.luxalgo.com/chart">Open Vela</a> · <a href="https://github.com/LuxAlgo">GitHub</a>
</div>

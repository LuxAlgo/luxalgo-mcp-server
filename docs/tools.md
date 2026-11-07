# Tools

Every tool the LuxAlgo MCP server registers, by area. Names are stable; every result is compact JSON with canonical URLs for citation. Back to the [README](../README.md).

## Which address does what

| Address | Used by | Notes |
| --- | --- | --- |
| `https://mcp.luxalgo.com/mcp` | Any MCP client | Every hosted tool. Standard OAuth discovery. |
| `https://mcp.luxalgo.com/mcp/openai` | ChatGPT (the LuxAlgo app) | Trimmed to the plugin directory's rules: no prop-firm offers or promo codes, and no Market Trackers. |
| `https://claude.mcp.luxalgo.com/mcp` | Claude custom connector | Trimmed the same way for prop firms; Market Trackers stay, without the political datasets or name search. Sign-in is requested only when an account tool is called ([why](https://github.com/anthropics/claude-ai-mcp/issues/1013)). Results do not carry `chart_url` yet. |

## What you can ask

| Ask | What answers |
| --- | --- |
| "Show BTC on 4 hour candles with RSI and a line at 80,000. Now switch to ETH." | `chart_open`, `chart_command` (self-hosted, charts on) |
| "Which Library indicators measure volatility? Open the first one on a chart." | `library_search`, then the indicator's `chart_url` on Vela |
| "Explain fair value gaps, then show me the Pine Script® source of the Fair Value Gap indicator." | `library_get_concept`, `library_get_source_code` |
| "How often does Bitcoin close green on a Monday?" | `edge_report` with the `day-of-week` preset |
| "With a 45% win rate at 2R, what are my odds on FTMO's 100K two-step?" | `propfirms_search_challenges`, `propfirms_simulate` |
| "Where did I lose money last month? Tag my worst trade 'chased'." | `journal_breakdown`, `journal_list_trades`, `journal_update_trade` (sign-in) |
| "Look at my chart in Vela: what do you see?" | `chart_peek` (sign-in, account tools on) |
| "What are my open positions across Alpaca and Kraken?" | `broker_positions` (local, your own read-only keys) |

## Live Vela charts

Self-hosted with `LUXALGO_CHART_TOOLS=on`; not on the hosted address yet. See [self-hosting.md](self-hosting.md#live-vela-charts).

| Tool | Returns |
| --- | --- |
| `chart_open` | An interactive Vela chart in the chat (market, timeframe, indicators, levels, zones, range) and its `chart_id` |
| `chart_command` | Edits to the open chart, applied in place; what it now shows, in words, plus the numbers on screen for exchange-fed markets |
| `chart_sync` | Used by the chart view only, never by the model |

## Library (public)

| Tool | Returns |
| --- | --- |
| `library_search` | One search over concepts (alias-aware) and indicators; indicator hits carry `chart_url` |
| `library_get_concept` | A concept page as markdown, plus its indicators, each with `chart_url` |
| `library_get_indicator` | An indicator's write-up, family, concepts, source availability and `chart_url` |
| `library_get_source_code` | Pine Script® source on demand: in full when publicly served, or the start of it (`complete: false`) where the app previews it to signed-out users |
| `library_list_concepts` | Concepts, paginated, optionally per family |
| `library_list_indicators` | Filtered, sorted, paginated indicators (family, concept, platform, tier) |
| `library_list_families` | The taxonomy with counts |
| `library_get_family` | A family hub as markdown, with its concepts |

## Edge Stats (public)

| Tool | Returns |
| --- | --- |
| `edge_symbols` | Covered symbols, session calendars, coverage windows, last build; each with `chart_url` |
| `edge_presets` | The precomputed questions, each stating what its number means |
| `edge_report` | One result with estimate, N, Wilson 95% CI, minimum-sample guards, stability split, per-year counts, distribution |

Every number arrives with its sample size. Computed nightly by the open-source [edge-stats](https://github.com/LuxAlgo/edge-stats) engine; opening-gap presets on round-the-clock markets are refused with the reason.

## Prop firms (public; the simulator runs inside the server)

| Tool | Returns |
| --- | --- |
| `propfirms_simulate` | Monte Carlo of your stats through a challenge's exact rules: pass probability with CI, killing rule, expected attempts and cost, EV, payout odds |
| `propfirms_simulate_trades` | The same from your real R-multiple trade series (block bootstrap keeps your streaks) |
| `propfirms_optimal_risk` | Pass-optimal vs EV-optimal risk per trade |
| `propfirms_compare` | One trader across up to 12 challenges, EV-sorted |
| `propfirms_pass_rates` | Reference odds per challenge, or a firm overview |
| `propfirms_validate_strategy` | One strategy screened across every simulatable challenge against a pass bar |
| `propfirms_list_simulatable` | Simulatable firms, or one firm's challenges |
| `propfirms_challenge_rules` | One challenge's encoded ruleset, editable and re-simulatable inline |
| `propfirms_search` | Firms by platform, market, payment, rating, country, with nested challenge and offer filters |
| `propfirms_get` | One firm's dossier: profile, challenges, live offers, page link |
| `propfirms_search_challenges` | Challenges by rules; natural queries such as "FTMO 2-step 100k" work |
| `propfirms_search_offers` | Current discounts and promo codes (not on the ChatGPT or Claude addresses) |

Simulations are distributions under stated assumptions, deterministic under seed, never predictions or financial advice. Engine: [prop-firm-sim](https://github.com/LuxAlgo/prop-firm-sim).

## Trade Journal and account (sign-in)

| Tool | Returns |
| --- | --- |
| `journal_list_accounts` | Journal accounts and the journal timezone (the first call: every `accounts` filter takes these ids) |
| `journal_overview` | The dashboard for a window: metrics, Edge Score, daily P&L, equity curve, open positions; optional comparison window |
| `journal_calendar` | One month of the P&L calendar |
| `journal_breakdown` | Closed trades by weekday, time of day, hold time, symbol, side, size, tag, rating, asset class |
| `journal_list_trades` | Trade summaries, filtered, sorted, keyset-paginated |
| `journal_get_trade` | One trade in full: fills, per-exit P&L, annotations |
| `journal_get_day` | One day's stats, trades and notes |
| `journal_list_tags` | Your tags, mistakes and playbooks with usage counts |
| `journal_search_notes` | Day and trade notes as one searchable stream |
| `journal_add_trade` | Log a trade by hand (fills into a manual or import account) |
| `journal_update_trade` | Annotate a trade: notes, tags, mistakes, playbook, rating, stop, target, reviewed |
| `journal_write_note` / `journal_update_note` | Add a day note, or edit or move one |
| `luxalgo_account` | Your plan, entitlements and profile basics |

These act only as you, on your own data, and the app validates every change. How sign-in works: [auth.md](auth.md).

## Watchlists, saved layouts, alerts and your open chart (sign-in)

Self-hosted with `LUXALGO_ACCOUNT_TOOLS=on`; not on the hosted addresses yet, and never on the Claude address while its directory review runs. The `alerts_*` tools also need `LUXALGO_ALERT_TOOLS=on`: LuxAlgo Alerts are not open to every member yet, so they stay off until they are.

| Tool | Returns |
| --- | --- |
| `watchlists_list` | Your watchlists, as Vela shows them, each symbol with its market and `chart_url` |
| `watchlists_create` | A new watchlist, optionally with its first symbols |
| `watchlists_add_symbols` / `watchlists_remove_symbols` | Add markets to a list, or take them out (the list itself stays) |
| `layouts_list` | Your saved Vela layouts, each with the link that opens it in Vela |
| `alerts_list` | Your Price Alerts and Custom Alerts in words, with how many are on against your plan |
| `alerts_create_price` | A Price Alert on a market and a level; draws the level on an open chart when given its `chart_id` |
| `alerts_create_custom` | A Custom Alert from a Vela built-in indicator or a Library indicator, after a history preview ("would have fired 12 times, about 0.4 per day"); `preview_only` creates nothing |
| `alerts_pause` / `alerts_resume` | Pause an alert, or turn it back on |
| `alerts_history` | When your alerts fired and whether each notification went out |
| `chart_peek` | A picture of the chart you have open in Vela, as you see it, with its market, timeframe and indicators in words and its `chart_url`; crypto charts fed by an exchange only (Binance, Binance.US, Coinbase, Hyperliquid), with your Vela tab open and visible |

Markets are named `source:TICKER` (`binance:BTCUSDT`, `hyperliquid:BTC`, `edgx:AAPL`, `fx:EURUSD`, `cme:ES1!`). Alerts notify your in-app channel (Vela on the web and the Vela app on your phone) when you have one, and say so plainly when they notify no one. Your plan sets the limits; nothing here deletes a watchlist, a layout or an alert. `chart_peek` asks your open Vela tab for its picture through the LuxAlgo app, which keeps nothing after the answer; for any market other than exchange-fed crypto it says so and sends no picture, and if no tab answers it asks you to open Vela at https://vela.luxalgo.com/chart, keep it visible and ask again in a minute.

## Brokers (local stdio only)

| Tool | Returns |
| --- | --- |
| `broker_setup` | Supported brokers, their env vars (set or unset, never values), read-only key guides |
| `broker_accounts` | Connected accounts: broker, currency, equity, cash |
| `broker_positions` | Open positions with market value, asset class, entry price |
| `broker_trades` | Trade history, newest first |
| `broker_stats` | Total and per-broker equity, top positions, FIFO win rate and realized P&L |
| `broker_refresh` | Re-fetch now, past the 5-minute cache |

Read-only by construction, via [broker-sdk](https://github.com/LuxAlgo/broker-sdk): it has no trading endpoints, and per-broker failures are reported, never dropped. Setup: [self-hosting.md](self-hosting.md#local-stdio).

## Market Trackers (public)

On the standard address, the Claude address and stdio; not on the ChatGPT address.

| Tool | Returns |
| --- | --- |
| `trackers_datasets` | Every dataset's rows, freshness and years; with `dataset`, its fields, filters, caveats and dump URLs |
| `trackers_query` | One dataset by ticker, text, field values and date range |
| `trackers_latest` | A dataset's newest daily delta |
| `trackers_ticker` | One ticker across every ticker-bearing dataset for a year |

The public record of US markets from primary sources: congressional trades, insider filings, 13F holdings, federal contracts, lobbying, short-sale volume, patents, clinical trials, FDA events, CFTC positioning and more, read from the CC0 dumps of [market-trackers](https://github.com/LuxAlgo/market-trackers) with a primary-source link on every row. Data only: no signals or scores.

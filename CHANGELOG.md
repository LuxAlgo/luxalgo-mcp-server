# Changelog

Notable changes to `@luxalgo/mcp`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [semver](https://semver.org/).

## [Unreleased]

## [1.4.0]

### Changed

- MCP SDK v2 and the 2026-07-28 protocol: the server now runs on `@modelcontextprotocol/server` 2 (replacing `@modelcontextprotocol/sdk` 1.x) and zod 4. All three entries serve the stateless 2026-07-28 protocol and still answer 2025-era clients (current Cursor builds included) through the SDK's per-request legacy fallback — stdio via `serveStdio`, the plain-Node HTTP entry via `createMcpHandler` + `@modelcontextprotocol/node`, and the Vercel entry via `mcp-handler` 2. Tool names, input schemas, and outputs are unchanged; `POST /mcp` and `/health` are unchanged.
- The Vercel entry now advertises the same `serverInfo` (`luxalgo` / package version) as the stdio and plain-Node entries instead of `mcp-handler`'s default.
- `@luxalgo/prop-firm-sim-mcp` 1.3.0: the simulator tools are re-exported from its new `/tools` and `/directory` package entry points instead of deep `dist/` imports, and share its zod 4 schemas directly (no more zod 3/4 split). Parity with the upstream handlers is unchanged and covered by `npm run test:parity`.
- `mcp-handler` moved from devDependencies to dependencies — it is imported at runtime by the Vercel function.
- `npm run typecheck` now also checks the Vercel entry (`api/server.ts`) through `tsconfig.api.json`. It sat outside the main tsconfig's `rootDir`, and Vercel's build only transpiles, so a type error there could previously reach production unnoticed.
- `@luxalgo/broker-sdk` ^0.5.0 (22 brokers and exchanges); the broker tools' description and the README now state that count (the 1.3.0 changelog entry below records the 16 that release shipped with).
- `package.json`, `server.json`, and the advertised server version are aligned (they had drifted across 1.3.0 / 1.3.1).

### Added

- Market Trackers tools: `trackers_datasets`, `trackers_query`, `trackers_latest`, `trackers_ticker`. The public record of US markets — congressional trades, insider (Forms 3/4/5) transactions, 13F holdings, federal contracts and grants, lobbying filings, FINRA short-sale volume, granted patents, clinical trials, FDA drug events, CFTC positioning, federal bills, FEC campaign finance, hearing transcripts, Federal Reserve communications, committee assignments, Wikipedia pageviews — read directly from the CC0 dumps published by [LuxAlgo/market-trackers](https://github.com/LuxAlgo/market-trackers) (live tree plus deep-history archive releases), streamed shard by shard under a per-call byte budget. Keyless; every row carries a primary-source `provenance.sourceUrl`.
- Edge Stats tools (all entries, hosted included): `edge_symbols`, `edge_presets`, `edge_report`. Hosted session statistics from the open-source [edge-stats](https://github.com/LuxAlgo/edge-stats) engine, precomputed nightly and served verbatim in the engine's honesty envelope (N, Wilson 95% CI, guards, stability split, per-year counts, disclaimer). Keyless; reads only public release artifacts containing derived statistics, never raw bars.
- `TRADEMARKS.md`, `SECURITY.md`, `CHANGELOG.md`, CODEOWNERS, and CI (build, dependency license gate, DCO check) ahead of the public release.

### Changed

- README redesigned around the LuxAlgo brand system.
- README documents charting tool output with [Vela](https://github.com/LuxAlgo/Vela): the `library_get_source_code` → `@luxalgo/vela-pinets` loop, with a real rendered SuperTrend and a table of what runs where (browser, not the server; AGPL Pine addon; attribution mark).
- The hosted root page (`mcp.luxalgo.com/`) shows a live Vela chart, rendered in the visitor's browser, with the same clarification.

## [1.3.0]

### Added

- Broker tools (local stdio only): `broker_setup`, `broker_accounts`, `broker_positions`, `broker_trades`, `broker_stats`, `broker_refresh`. Read-only portfolio access across 16 brokers and exchanges via `@luxalgo/broker-sdk`; credentials come exclusively from env vars and never leave the machine.

## [1.2.0]

### Added

- Prop-firm challenge simulator tools via `@luxalgo/prop-firm-sim`: `propfirms_list_simulatable`, `propfirms_challenge_rules`, `propfirms_simulate`, `propfirms_simulate_trades`, `propfirms_optimal_risk`, `propfirms_compare`, `propfirms_pass_rates`, `propfirms_validate_strategy`.

## [1.1.0]

### Added

- Prop-firm directory tools: `propfirms_search`, `propfirms_get`, `propfirms_search_challenges`, `propfirms_search_offers`.
- Library tags and filtered browsing: `library_list_tags`, richer `library_list_indicators` filters.
- `server.json` manifest for the MCP registry.

## [1.0.0]

### Added

- Initial release: the LuxAlgo Library over MCP (`library_search`, `library_get_concept`, `library_get_indicator`, `library_get_source_code`, `library_list_concepts`, `library_list_indicators`, `library_list_families`, `library_get_family`), hosted at `https://mcp.luxalgo.com/mcp` and runnable locally over stdio.

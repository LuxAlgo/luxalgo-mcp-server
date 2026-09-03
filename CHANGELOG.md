# Changelog

Notable changes to `@luxalgo/mcp`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [semver](https://semver.org/).

## [Unreleased]

### Added

- Market Trackers tools: `trackers_datasets`, `trackers_query`, `trackers_latest`, `trackers_ticker`. The public record of US markets — congressional trades, insider (Forms 3/4/5) transactions, 13F holdings, federal contracts and grants, lobbying filings, FINRA short-sale volume, granted patents, clinical trials, FDA drug events, CFTC positioning, federal bills, FEC campaign finance, hearing transcripts, Federal Reserve communications, committee assignments, Wikipedia pageviews — read directly from the CC0 dumps published by [LuxAlgo/market-trackers](https://github.com/LuxAlgo/market-trackers) (live tree plus deep-history archive releases), streamed shard by shard under a per-call byte budget. Keyless; every row carries a primary-source `provenance.sourceUrl`.
- `TRADEMARKS.md`, `SECURITY.md`, `CHANGELOG.md`, CODEOWNERS, and CI (build, dependency license gate, DCO check) ahead of the public release.

### Changed

- README redesigned around the LuxAlgo brand system.

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

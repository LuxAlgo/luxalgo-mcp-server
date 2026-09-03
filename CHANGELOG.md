# Changelog

Notable changes to `@luxalgo/mcp`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [semver](https://semver.org/).

## [Unreleased]

### Added

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

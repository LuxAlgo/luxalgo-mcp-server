# Changelog

Notable changes to `@luxalgo/mcp`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [semver](https://semver.org/).

## [Unreleased]

## [1.5.0] - 2026-09-24

### Added

- **Trade Journal tools** (`journal_*`, thirteen, all sign-in required): the signed-in user's journal in the LuxAlgo app. Reads — `journal_list_accounts` (accounts + the journal timezone; the first call, since every `accounts` filter takes its ids), `journal_overview` (metrics, Edge Score, daily P&L, equity curve, open positions, accounts and settings for a window, with an optional previous-window comparison), `journal_calendar`, `journal_breakdown` (P&L by weekday, time of day, hold time, symbol, side, size, tag, rating, asset class), `journal_list_trades` (keyset-paginated summaries with account / day-window / symbol / direction / status / tag filters), `journal_get_trade` (fills, per-exit P&L, all annotations), `journal_get_day`, `journal_list_tags` (the user's tag / mistake / playbook vocabulary with usage counts), `journal_search_notes` (day notes and trade notes as one paginated, text-searchable stream). Writes — `journal_add_trade` (fills into a manual or import account; returns the resulting trades), `journal_update_trade` (notes, tags and mistakes with replace or add/remove forms, playbook, rating, stop loss, profit target, reviewed), `journal_write_note`, `journal_update_note`. Everything runs as the signed-in user against the app's `/api/journal/*` routes; the app owns validation and entitlements as for every other tool.
- `journal_list_trades` takes `sort` (`openedAt` default, `closedAt`, `netPnl`, `grossPnl`, `durationMs`, `quantity`, `symbol`, `rating` — named after the summary fields) and `order` (`desc` default; `symbol` defaults to `asc`), mirroring the app's `GET /api/journal/trades`. Trades without the sort value (open trades for `closedAt`/`durationMs`, unrated for `rating`) come last either way; a cursor only pages within the same sort and order.
- `appSend()` in `src/platform/app-client.ts`: the first write path to the app (POST / PATCH / PUT / DELETE), sharing `appGet`'s envelope handling and 401/403 mapping. It has no anonymous form — with no ambient token it throws `AppAuthError` before any request goes out, so a caller without a sign-in meets the challenge, not a half-made write.
- `LUXALGO_SECURITY_SCHEMES=off` removes the per-tool `securitySchemes` hint from `tools/list`. Added to test whether Claude.ai's connector reads that field when it decides to sign users in at connect time; the 401 challenge on protected calls is unchanged. (Ruled out: production ran with it off and Claude.ai still signed users in at connect — the well-known PRM probe is the trigger; tracked as [claude-ai-mcp#1013](https://github.com/anthropics/claude-ai-mcp/issues/1013).)
- `LUXALGO_REACTIVE_AUTH_ONLY=on` (default off) makes auth discovery purely reactive while [claude-ai-mcp#1013](https://github.com/anthropics/claude-ai-mcp/issues/1013) is open: the two well-known PRM paths answer 404 and the metadata document moves to `/auth/prm` (clients learn it from the 401's `resource_metadata`), leaving the anonymous origin indistinguishable from an authless server's — `/register` included, which stays 404: the official `modelcontextprotocol/ext-apps` lazy-auth example (`REACTIVE_AUTH_ONLY`, which this ports) answers it with an RFC 7591 "not supported" error, but claude.ai surfaces that 400 as a fatal registration failure instead of connecting without auth. Deliberately non-RFC 9728 while on — see `docs/auth.md` §5 for what to verify after enabling.
- `Dockerfile` and `.dockerignore`: an image that runs the stdio server (`node dist/index.js`), for MCP directories such as Glama that build the repository and introspect the running server.
- The Release workflow publishes `server.json` to the official MCP Registry (`io.github.LuxAlgo/luxalgo-mcp-server`) after the npm publish, with a pinned `mcp-publisher` and GitHub OIDC (no secret). It can also be started by hand from main (`workflow_dispatch`), and it skips `npm publish` when the version is already on npm, so a re-run still reaches the registry step.

### Changed

- Every tool now declares MCP `annotations` (`readOnlyHint`, `openWorldHint`; the journal writes already carried `destructiveHint`) — the journal and account domains had them, the read-only domains (library, propfirms, trackers, edge, broker) did not, and the MCP directory's review criteria ask for them on every tool.
- App API errors other than 401/403 now carry the app's own message when it sent one (`"Trade not found"`, `"Nothing to update"`, `"Account not found"`) instead of the generic `LuxAlgo API <status> for <path>`; the status is unchanged and `isNotFound()` still works. The journal routes answer 400/404 with plain-language reasons an agent needs to recover, and the other domains gain the same.
- The smoke surface suite derives its protected-tool assertions from one `PROTECTED` list (`test/smoke/surface.mjs`) instead of naming `luxalgo_account`; a new `journal` suite checks that reads and writes alike are refused anonymously (401 hosted, in-band on stdio) and that the input schemas are on the wire as designed. The stdio server under test now runs with `LUXALGO_MCP_AUTH_FILE` pointed at an absent file, so a developer's own `luxalgo-mcp login` can no longer turn the suite's "anonymous" protected calls — one of which is a write — into real requests against their account.
- The anonymous 401 on a protected tool now carries `error="invalid_token", error_description="Authentication required for this tool"` and lists the challenge parameters in the order Anthropic's lazy-authentication guide shows — the same signal, byte-compatible with their sample. The smoke suite asserts the wire response (status + header) instead of the SDK client's error text.

- README: Claude (web/desktop/mobile) install instructions. Claude.ai signs in at connect time for any server with discoverable OAuth metadata — it fetches the well-known PRM itself after a successful anonymous handshake, under either *Authentication* setting — so the docs now say so instead of promising lazy auth there. `docs/auth.md` records the observed request sequence so nobody treats the connect-time popup as a server bug.
- `server.json`: a registry description within the schema's 100-character limit (the previous 405-character one failed validation), a `title`, and `websiteUrl` [luxalgo.com/mcp](https://www.luxalgo.com/mcp). `package.json` gains the same `homepage` and a description that includes Edge Stats and the Trade Journal.
- README: an H1 and a link to [luxalgo.com/mcp](https://www.luxalgo.com/mcp).

## [1.4.1]

### Changed

- Source layout reorganised by concern (no change to tool names, schemas, outputs, the wire protocol, or the `luxalgo-mcp` binary). `src/lib/` is gone: each tool domain now lives in `src/tools/<domain>/` behind a declarative `ToolModule` (`index.ts`: tool names, which are protected, whether the module is local-only), listed once in `src/server/manifest.ts`; registration asserts every module registers exactly the tools it declares, and the HTTP gate's protected-tool set and the `securitySchemes` hint are derived from the manifest instead of being maintained by hand. OAuth moved to `src/auth/` (the former `protected-tools.ts` split into `runtime`, `errors`, `instrument`, `protected-tool`), the app HTTP client to `src/platform/app-client.ts` with per-domain endpoint wrappers next to their tools, and the entries to `src/entries/` (`stdio`, `node-http`, `hosted`). The 900-line simulator file is now `tools/propfirms/simulation/{package-tools,shared,pass-rates,validate-strategy}.ts`; the twelve copies of `json` / `toolError` / `compact` are one `tools/_shared/`.
- `npm run start:http` now runs `dist/entries/node-http.js`; `dist/http.js` remains as a shim so existing `node dist/http.js` process managers keep working.
- Tests moved from `scripts/` to `test/`; the smoke suite is split per domain under `test/smoke/` (run a subset with `node test/smoke.mjs --only library,edge`) and now also asserts that the advertised server version matches `package.json`.
- The shared `guarded()` result helper lets the app's 401/403 (`AppAuthError` / `AppPermissionError`) propagate to the auth wrapper instead of flattening them into a generic tool error, so a tool using it still yields the sign-in challenge or the upgrade message.

### Added

- `AGENTS.md` (rules and the add-a-tool recipe for AI coding agents; `CLAUDE.md` imports it for Claude Code) and `docs/auth.md` (how OAuth, token forwarding and the public/protected distinction work, and what tool code may and may not do).

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

- OAuth 2.1 sign-in with a LuxAlgo account, with [app.luxalgo.com](https://app.luxalgo.com) as the authorization server and this server as an RFC 9728 protected resource (`https://mcp.luxalgo.com/mcp`). Public tools keep working anonymously; protected tools need a signed-in user. This server makes no entitlement decisions of its own: once the caller has a token, every request a tool makes to the app carries it as a bearer, and the app resolves the user and their plan exactly as it does for a browser session — answering `401` (→ sign-in challenge) or `403` with the failing permission (→ "your plan does not include this") when appropriate.
  - Hosted entries (Vercel and plain Node) serve `/.well-known/oauth-protected-resource` (root and path-inserted forms), verify bearer tokens offline against the app's JWKS (issuer, audience, expiry; DPoP-bound tokens are refused since the resource advertises no DPoP support), and refuse an anonymous call to a protected tool with `401` + `WWW-Authenticate` pointing at the metadata — "lazy" auth, so `initialize` and `tools/list` never prompt. `LUXALGO_AUTH_CHALLENGE=result` switches the anonymous-protected-call case to an in-band tool error carrying `_meta["mcp/www_authenticate"]`.
  - `tools/list` declares a per-tool `securitySchemes` (`noauth` / `oauth2` + scopes), the extension ChatGPT keys its per-tool linking on; other clients ignore it.
  - Local (stdio) entry: `npx -y @luxalgo/mcp login` / `logout` / `status`. The local server is itself the OAuth client (authorization code + PKCE, loopback redirect, refresh tokens; identified by the Client ID Metadata Document at `/oauth/client.json`, or DCR against a non-https resource). Tokens are stored owner-only under the user's config dir (`LUXALGO_MCP_AUTH_FILE` to override) and refreshed silently. With a client that supports URL-mode elicitation (MCP 2026-07-28), the first protected call signs in in-session instead.
  - First protected tool: `luxalgo_account` — plan tier, entitlements and profile basics from the app's `/api/account/me`, on every entry.
- New runtime dependencies: `jose` (JWT verification) and `@modelcontextprotocol/client` (the SDK's OAuth client, previously dev-only).
- Env: `MCP_RESOURCE` (resource identifier / token audience, default `https://mcp.luxalgo.com/mcp`); the issuer follows the existing `LUXALGO_APP_ORIGIN`.
- The smoke suite (`npm test`, `npm run test:http`) now also checks the advertised `securitySchemes` on the wire and the unauthenticated behaviour of `luxalgo_account` on both transports.
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

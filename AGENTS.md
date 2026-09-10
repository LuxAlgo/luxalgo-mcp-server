# Working in this repository (for AI coding agents)

This is `@luxalgo/mcp`, the LuxAlgo MCP server: tools that AI clients (Claude, ChatGPT, Cursor, …) call to read LuxAlgo data. Most work here is **adding or changing tools** under `src/tools/<domain>/`. Read this file, then `docs/auth.md` in full before touching anything.

## Hard rules

1. **Do not modify authentication or infrastructure code** — `src/auth/`, `src/platform/app-client.ts`, `src/server/`, `src/entries/`, `api/server.ts`, `public/oauth/`, `vercel.json` — unless a maintainer explicitly asks for that change in this conversation. If a task seems to require it, stop and say so instead of doing it.
2. **Never check entitlements, plans, roles, or permissions in this repo.** The LuxAlgo app decides; this server forwards the user's token and relays the app's answer. `docs/auth.md` §1 explains why. There is no "is this user Premium" check anywhere here and there must not be one.
3. **Call the app only through `appGet()` (reads) and `appSend()` (writes)** (`src/platform/app-client.ts`). Never `fetch()` `app.luxalgo.com` directly. Never read, store, log, or print a token. `appSend` has no anonymous form: it is only for protected tools acting on the signed-in user's own data (today: the journal).
4. **Never catch and swallow `AppAuthError` / `AppPermissionError`.** Rethrow them from any `catch`; the auth wrapper turns them into the sign-in / upgrade results the client understands. `guarded()` in `tools/_shared/result.ts` already does this.
5. **Never cache a response fetched with a user's token.** In-process caches must fetch with `appGet(path, query, { access: null })`.

## Layout

```
src/tools/<domain>/   one directory per tool domain; index.ts exports a ToolModule
src/tools/_shared/    json/toolError/ok/guarded (result.ts), compact/fmtPct/fmtMoney (format.ts), ToolModule type
src/server/           manifest.ts (list of modules — the only file outside tools/ you edit when adding a domain)
src/auth/             OAuth — read docs/auth.md; do not edit
src/platform/         appGet (the app HTTP client), analytics — do not edit
src/entries/          stdio / node-http / hosted entry points — do not edit
test/                 smoke.mjs runner + smoke/<domain>.mjs, parity.mjs, trackers-check.mjs
```

## Adding a tool

1. Implement it in `src/tools/<domain>/tools.ts` (or a new domain directory) with `server.registerTool(name, { title, description, inputSchema: z.object({...}) }, handler)`. Results come from `json(...)` / `toolError(...)` in `tools/_shared/result.ts`. Names are `<domain>_<verb_noun>`, lowercase, underscores.
2. Declare it in the domain's `index.ts` (`tools: [...]`). If the app route it calls **requires** a signed-in user (returns 401 anonymously), register it with `registerProtectedTool(server, auth, ...)` and also list it in `protectedTools`. Otherwise leave it public — the user's token is forwarded anyway when present. Do not make tools protected "to be safe".
3. New domain: add its module to `TOOL_MODULES` in `src/server/manifest.ts`. Startup asserts the module registers exactly the tools it declares; a mismatch refuses to start.
4. Tests: add the name to `expected` in `test/smoke/surface.mjs` and a check in `test/smoke/<domain>.mjs` (create the suite and list it in `test/smoke.mjs` for a new domain). A new protected tool goes in the `PROTECTED` list in `surface.mjs` instead (that list drives both the tool count and the `securitySchemes` assertions).
5. Docs: add the tool to the relevant section of `README.md` ("Tools") and a line under `## [Unreleased]` in `CHANGELOG.md`.

Descriptions are read by AI models, not humans: say what the tool returns, when to use it versus sibling tools, and what it is not (see existing descriptions for the tone). Tool results are compact JSON with canonical URLs where possible.

## Verify before finishing

```bash
npm run typecheck && npm run build && npm test     # smoke suite hits live endpoints
npm run test:parity                                  # if you touched src/tools/propfirms/simulation/
npm run test:trackers                                # if you touched src/tools/trackers/
node test/smoke.mjs --only <domain>                  # quick loop while iterating
```

`SERVER_VERSION` in `src/server/version.ts` must equal `package.json`'s version (a smoke check enforces it); bump both only when cutting a release.

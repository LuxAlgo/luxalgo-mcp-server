# How authentication works in this server

Audience: AI coding agents (and the people directing them) who add or change **tools** in this repository. You need to understand this document fully. You will almost never need to change anything it describes — and you must not, unless a maintainer explicitly asks for an auth change.

Everything auth-related lives in `src/auth/`, `src/platform/app-client.ts`, `src/server/`, and `src/entries/`. Tool code lives in `src/tools/<domain>/`. Tool code never imports from `src/auth/` except the two symbols in [What a tool may import](#what-a-tool-may-import).

---

## 1. The one idea to remember

**This server never decides what a user is allowed to see. The LuxAlgo app does.**

This code is public and open source. Any check written here ("is this user Premium?") could be deleted by whoever runs their own copy of the server. So there is no such check anywhere in this repository, and you must not add one.

Instead:

1. A user signs in with their LuxAlgo account (OAuth). The result is an **access token** — a signed string that says "this is user X, issued by app.luxalgo.com, for use with mcp.luxalgo.com".
2. When a tool needs data, it calls the LuxAlgo app's API through `appGet()`. `appGet()` automatically attaches the user's token as `Authorization: Bearer <token>`.
3. The app reads the user from the token exactly as it would from a browser session and applies **its own** rules: it returns the data, or `401` ("I need a signed-in user and there is none"), or `403` ("this user's plan does not allow this").
4. This server translates `401`/`403` into the right answer for the AI client automatically (see [§6](#6-what-happens-when-the-app-says-no)).

A tampered copy of this server can only ever present the user's own token, so it can do no more than that user could in the browser. That is the whole security model. Tools are written as if the user is always allowed; the app says otherwise when they are not.

---

## 2. The three parties

| Party | Role in OAuth terms | What it does |
|---|---|---|
| **The MCP client** (Claude, ChatGPT, Cursor, Claude Code, …) | OAuth client (hosted case) | Talks MCP to this server. When told "sign in", runs the OAuth flow in the user's browser and then sends the token with every request. |
| **This server** (`@luxalgo/mcp`, mcp.luxalgo.com) | **Protected resource** (RFC 9728) | Serves tools. Verifies tokens it is handed. Tells clients where to sign in. Forwards the token to the app. Decides nothing about entitlements. |
| **The LuxAlgo app** (app.luxalgo.com) | **Authorization server** and the API | Signs users in, asks for consent, mints tokens (`/api/auth/oauth2/*`). Also serves the data API (`/api/...`) and enforces plans and permissions there. |

Two identifiers tie the parties together and must match the app's configuration byte for byte (`src/auth/config.ts`):

- `AUTH_ISSUER` = `<LUXALGO_APP_ORIGIN>/api/auth` — who mints tokens (`iss` claim), and where the app publishes its OAuth metadata and signing keys (JWKS).
- `MCP_RESOURCE` = `https://mcp.luxalgo.com/mcp` by default — this server's identity; the token's audience (`aud`). A token minted for anything else is useless here, and ours are useless elsewhere.

---

## 3. Two ways this server runs, two places the token comes from

The tool code is identical in both cases. Only the source of the token differs, and that difference is hidden behind an `AuthRuntime` (`src/auth/runtime.ts`) that the entry injects.

### 3a. Hosted (mcp.luxalgo.com — Vercel `api/server.ts`, or plain Node `src/entries/node-http.ts`)

The **MCP client** is the OAuth client. The user signs in inside Claude/ChatGPT/Cursor; the client then sends `Authorization: Bearer <token>` on every HTTP request to `/mcp`.

This server:

1. Verifies the token **offline** (`src/auth/verify.ts`): signature against the app's JWKS, `iss` = `AUTH_ISSUER`, `aud` = `MCP_RESOURCE`, not expired, has a `sub` (user id). No database, no call to the app. Tokens carrying a DPoP binding (`cnf`) are refused because this resource does not advertise DPoP.
2. Hands the verified identity to the SDK, which exposes it to tools as `ctx.http.authInfo`. `hostedAuthRuntime` turns that into an `Access` (`{ token, userId, email }`).

A hosted server is built fresh **per request** and holds nothing between requests. It never stores tokens.

### 3b. Local (`npx -y @luxalgo/mcp`, stdio — `src/entries/stdio.ts`)

There is no HTTP, so there is no bearer header. **This process itself is the OAuth client** (`src/auth/local/`):

- `npx -y @luxalgo/mcp login` opens the browser, the user signs in on app.luxalgo.com, approves consent, and is redirected to a one-shot listener on `127.0.0.1`. Authorization code + PKCE (RFC 8252 native app flow). Tokens (access + refresh) are stored in **one owner-only file** under the user's config directory (`~/.config/luxalgo/mcp-auth.json`, or `LUXALGO_MCP_AUTH_FILE`). `logout` deletes it; `status` shows who is signed in.
- Client identity: over https, the static **Client ID Metadata Document** at `public/oauth/client.json` (served by mcp.luxalgo.com) — no per-machine registration, no client secret (public native client). Against a `localhost` resource in development, the SDK falls back to **Dynamic Client Registration**, which the app also allows.
- At tool-call time, `createLocalAuthRuntime` reads the stored token, **silently refreshes** it if it is within 60 s of expiry (concurrent refreshes are serialized; a refresh that fails because the refresh token was revoked signs the user out), and hands it to the tool. If nothing usable is stored and the MCP client supports **URL-mode elicitation** (MCP 2026-07-28), a protected tool triggers the browser sign-in in-session; otherwise the tool answers "run `npx -y @luxalgo/mcp login`".

The token is only ever sent to the LuxAlgo app. The MCP client on the machine never sees it.

---

## 4. Public tools vs protected tools

Every tool is one of two kinds. **The kind changes the user experience, not the security.** Security is §1: the app checks the forwarded token no matter what this server thinks.

| | Public tool (default) | Protected tool |
|---|---|---|
| Works without a sign-in? | Yes | No — the caller gets a sign-in challenge before the handler runs |
| Registered with | `server.registerTool(...)` | `registerProtectedTool(server, auth, ...)` from `src/auth/protected-tool.ts` |
| Declared in the module's `index.ts` | in `tools` | in `tools` **and** `protectedTools` |
| Token forwarded to the app? | **Yes, if the caller has one** (opportunistic — lets the app personalise or unlock content on routes where a user is optional). Anonymous callers are never prompted. | Yes, always |
| Advertised in `tools/list` as | `securitySchemes: [{ type: "noauth" }]` | `securitySchemes: [{ type: "oauth2", scopes: [...] }]` — ChatGPT keys its per-tool linking on this |
| Description | as written | `"<your description> Requires signing in with a LuxAlgo account (OAuth)."` appended automatically |

**Make a tool protected when** it only makes sense for a signed-in user — that is, when the app route it calls *requires* a user (returns 401 anonymously). Example: `luxalgo_account` calls `/api/account/me`, which needs a user. Marking it protected means the user is asked to sign in up front instead of after a wasted round-trip, and ChatGPT knows to offer linking.

**Leave a tool public when** the app route works anonymously (library, prop firms, trackers, edge stats). If the route also personalises for signed-in users, you get that for free: the token is forwarded whenever the caller has one.

Do not make a tool protected "to be safe". It does not add security (see §1); it only forces a sign-in on people who did not need one.

### The manifest is the source of truth

`src/server/manifest.ts` lists every tool module. From each module's `index.ts`, the server derives:

- `PROTECTED_TOOL_NAMES` — read by the HTTP gate (§5) and by the `securitySchemes` hint;
- which modules are `localOnly` (broker tools: they hold the user's own broker keys and must never run hosted).

At startup, `registerLuxalgoTools` (`src/server/create-server.ts`) verifies that every module registered **exactly** the tool names it declared and that every `protectedTools` entry is among them. A mismatch throws — the process refuses to start. This is deliberate: it makes it impossible to add a protected tool the gate does not know about.

---

## 5. Life of a request (hosted)

`withLuxalgoAuth` (`src/auth/gate.ts`) sits in front of the MCP handler. This is "lazy authentication": the server is fully usable before sign-in, and clients only meet OAuth when they call something that needs it.

```
request to /.well-known/oauth-protected-resource[/mcp]
  → RFC 9728 metadata: { resource, authorization_servers: [AUTH_ISSUER], scopes_supported, … }
    This is how a client that was just refused finds out where to sign in.

request with  Authorization: Bearer <token>
  → verify (§3a). Invalid/expired → 401 + WWW-Authenticate (client re-authenticates).
    Valid → proceed with identity. Applies to EVERY request, including initialize and tools/list,
    so a client that believes it is signed in learns about a revoked token immediately.

request with no token
  → initialize, tools/list, tools/call of a PUBLIC tool: served anonymously.
  → tools/call of a PROTECTED tool (name ∈ PROTECTED_TOOL_NAMES):
      401 + WWW-Authenticate: Bearer resource_metadata="<PRM URL>", scope="openid profile email offline_access"
      The client reads resource_metadata, discovers the app, runs OAuth, retries with a token.
      (LUXALGO_AUTH_CHALLENGE=result switches this one case to an in-band tool error carrying
       _meta["mcp/www_authenticate"] — the shape ChatGPT documents. Off by default.)
```

On stdio there is no HTTP status, so a protected tool with no sign-in always answers the in-band form: `isError: true`, human text with the `login` hint, and `_meta["mcp/www_authenticate"]` with the same challenge string (`signInRequiredResult` in `src/auth/challenge.ts`).

**A sign-in popup at connect time in Claude.ai is not a bug in this server.** Verified in production logs (Sep 2026): Claude runs `initialize` and `tools/list` anonymously (both 200, no challenge from us), then fetches `/.well-known/oauth-protected-resource/mcp` on its own and starts OAuth. Anthropic's own [lazy-authentication guide](https://claude.com/docs/connectors/building/lazy-authentication) describes this server's exact shape and says the connect-time prompt should not occur with *Required when the server asks*; the observed behaviour differs, and that discrepancy is Anthropic's to resolve, not ours. Do not "fix" it by removing or relocating the well-known metadata (RFC 9728 §3 requires it and other clients discover through it) or by loosening the gate — point people at the README's Claude install note instead.

---

## 6. What happens when the app says no

Every tool's callback is wrapped once at registration (`instrumentToolRegistration`, `src/auth/instrument.ts`). The wrapper does two things for the whole duration of the call:

1. Makes the caller's `Access` **ambient** via `AsyncLocalStorage` (`src/auth/access-context.ts`). `appGet()` reads `currentAccess()` and adds the `Authorization` header. Nothing is threaded through function signatures.
2. Catches the two typed errors `appGet()` throws and turns them into proper tool results (`appErrorResult`, `src/auth/errors.ts`):

| App answered | `appGet` throws | The AI client receives |
|---|---|---|
| `401` | `AppAuthError` | The sign-in challenge (`error="invalid_token"`, "Your LuxAlgo sign-in is missing or no longer valid") — same shape as §5, so the client re-authenticates |
| `403` | `AppPermissionError` (with `permission` when the app named one) | `isError: true`, text: "Your LuxAlgo plan does not include this (`<permission>`): `<app message>`. Upgrading at https://app.luxalgo.com/account/plan unlocks it." |
| other non-2xx | `AppApiError` | Whatever your tool does with a thrown error (usually a `toolError(...)` via `guarded`) |

**Consequence for tool authors:** you never catch `AppAuthError` or `AppPermissionError`. Let them propagate. If you catch broadly (`catch (error) { return toolError(...) }`), rethrow those two first — otherwise a "please sign in" becomes a generic failure and the client cannot recover. The helper `guarded()` in `tools/_shared/result.ts` is safe to use for public tools that call the app; if you write your own try/catch, add:

```ts
} catch (error) {
  if (error instanceof AppAuthError || error instanceof AppPermissionError) throw error;
  return toolError(errorMessage(error));
}
```

---

## 7. What a tool may import

From the auth side, exactly two things:

```ts
import { registerProtectedTool } from "../../auth/protected-tool.js"; // only for protected tools
import type { AuthRuntime } from "../../auth/runtime.js";              // only to type the parameter you pass along
```

From the platform side:

```ts
import { appGet, appSend, AppAuthError, AppPermissionError, isNotFound } from "../../platform/app-client.js";
```

`appGet(pathname, query?, { access? })`:

- `access` omitted → uses the ambient token (the normal case — do this).
- `access: null` → **anonymous on purpose**. Use only for data that is cached in-process and shared by every caller (see `getConcepts` in `tools/library/api.ts`): a personalised response must never be cached and served to someone else.
- `access: someAccess` → explicit token. Protected handlers receive their `Access` as a parameter, but the ambient one is already set to the same value, so you will not need this.

`appSend(method, pathname, { query?, body? })` — POST / PATCH / PUT / DELETE as the signed-in user (see `tools/journal/api.ts`). It always uses the ambient token and has no `access` option: with no token it throws `AppAuthError` before sending anything, so an anonymous caller gets the sign-in challenge rather than a half-made write. Only protected tools should call it, and only against routes that act on the user's own data.

Nothing else in `src/auth/` is for tools. In particular, do not import `currentAccess`/`runWithAccess`, `verifyAccessToken`, anything from `auth/local/`, or `config.ts` constants.

---

## 8. Recipes

### Public tool that calls the app

```ts
// src/tools/<domain>/tools.ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { appGet } from "../../platform/app-client.js";
import { json } from "../_shared/result.js";

export function registerThingTools(server: McpServer) {
  server.registerTool(
    "thing_get",
    { title: "…", description: "…", inputSchema: z.object({ id: z.string() }) },
    async ({ id }) => json(await appGet(`/api/things/${encodeURIComponent(id)}`)),
    // The token (if the caller has one) is already on that request. 401/403 are already handled.
  );
}
```

```ts
// src/tools/<domain>/index.ts
export const thingModule: ToolModule = {
  id: "thing",
  tools: ["thing_get"],
  register: (server) => registerThingTools(server),
};
```

Then add `thingModule` to `TOOL_MODULES` in `src/server/manifest.ts`.

### Protected tool

```ts
import { registerProtectedTool } from "../../auth/protected-tool.js";
import type { AuthRuntime } from "../../auth/runtime.js";

export function registerThingTools(server: McpServer, auth: AuthRuntime) {
  registerProtectedTool(
    server,
    auth,
    "thing_mine",
    { title: "…", description: "…", inputSchema: z.object({}) },
    async () => json(await appGet("/api/things/mine")), // the handler only ever runs with a signed-in user
  );
}
```

```ts
export const thingModule: ToolModule = {
  id: "thing",
  tools: ["thing_mine"],
  protectedTools: ["thing_mine"],
  register: (server, { auth }) => registerThingTools(server, auth),
};
```

### Things you do not write

- `if (user.plan !== "premium") return toolError(...)` — never. The app route decides; you get a 403 mapped for you.
- Reading, storing, logging, or printing a token. Tools do not see tokens; `Access` is only in the protected handler's parameter list for identity (`userId`, `email`) and you rarely need even that.
- Calling `fetch()` against `app.luxalgo.com` directly. Always `appGet()` / `appSend()`; they are the only place the header is attached and the only place 401/403 are typed.
- Caching a response that was fetched with a user's token. If you need an in-process cache, fetch with `access: null`.
- Adding an entry to `PROTECTED_TOOL_NAMES` by hand — it is derived from the module manifests.
- Importing from `src/auth/local/`, `src/auth/gate.ts`, `src/auth/verify.ts`, or touching `src/entries/` or `api/server.ts`.

---

## 9. How to know it works

`npm test` (stdio) and `npm run test:http` (against `npm run start:http`) run `test/smoke/surface.mjs` and `test/smoke/account.mjs`, which assert:

- every tool advertises `securitySchemes` on the wire, `noauth` for public and `oauth2` for protected;
- the exact tool set per entry (the local-only broker tools are absent when hosted);
- an anonymous call to a protected tool is refused with the RFC 9728 challenge (HTTP 401 when hosted, in-band `_meta` on stdio).

When you add a tool, add it to the `expected` list in `test/smoke/surface.mjs` and a check in your domain's `test/smoke/<domain>.mjs`. A protected tool goes in the `PROTECTED` list there instead: it feeds `expected`, the `noauth` assertion excludes it, and the `oauth2` assertion covers it. `test/smoke/journal.mjs` is the template for a protected domain — it checks a read and a write are both refused anonymously (401 hosted, in-band on stdio) and that the input schemas reach the wire.

For a local end-to-end run against a development app: `LUXALGO_APP_ORIGIN=http://localhost:3001 MCP_RESOURCE=http://localhost:3333/mcp`, with the app's `LUXALGO_MCP_SERVER_RESOURCE` set to the same resource; then `npx -y @luxalgo/mcp login` with the same env for the stdio side.

---

## 10. Environment variables (reference — you set none of these in tool code)

| Variable | Default | Meaning |
|---|---|---|
| `LUXALGO_APP_ORIGIN` | `https://app.luxalgo.com` | The app: authorization server **and** the API `appGet` calls. Issuer is `<origin>/api/auth`. |
| `MCP_RESOURCE` | `https://mcp.luxalgo.com/mcp` | This server's resource identifier = token audience. Must equal the app's `LUXALGO_MCP_SERVER_RESOURCE`. |
| `LUXALGO_AUTH_CHALLENGE` | `http` | `result` makes the hosted entries answer an anonymous protected call in-band instead of 401. |
| `LUXALGO_MCP_AUTH_FILE` | `~/.config/luxalgo/mcp-auth.json` | Where the local (stdio) client stores tokens. |

---

## 11. File map

```
src/auth/
  config.ts          AUTH_ISSUER, MCP_RESOURCE, JWKS_URL, PRM paths, OAUTH_SCOPES, challenge mode
  access-context.ts  Access type; AsyncLocalStorage making the token ambient per call
  runtime.ts         AuthRuntime (where a token comes from) + hostedAuthRuntime
  gate.ts            withLuxalgoAuth — the HTTP gate (metadata, bearer verification, lazy 401)
  verify.ts          offline JWT verification against the app's JWKS
  metadata.ts        RFC 9728 protected-resource document
  challenge.ts       WWW-Authenticate header, 401 response, in-band sign-in result
  errors.ts          AppAuthError / AppPermissionError → tool results
  instrument.ts      instrumentToolRegistration (ambient token + error mapping), advertiseSecuritySchemes
  protected-tool.ts  registerProtectedTool
  local/             the stdio process as an OAuth client: cli, login (PKCE + loopback), provider, runtime, store
src/platform/app-client.ts   appGet / appSend — the only HTTP client for the app; attaches the ambient token; types 401/403
src/server/manifest.ts       TOOL_MODULES → PROTECTED_TOOL_NAMES, local-only modules
src/server/create-server.ts  registration order: analytics → instrument → modules (asserted) → securitySchemes
public/oauth/client.json     Client ID Metadata Document identifying the local client
```

The app side (in the `app` repository, for reference only): `src/server/services/auth/service.ts` (better-auth `mcp()` plugin, bearer-before-session resolution in `extractAuthFromRequest`), `mcp-server-bearer.ts` (how the app verifies the tokens this server forwards), `mcp-server-resource.ts` (`LUXALGO_MCP_SERVER_RESOURCE`), `/api/account/me`.

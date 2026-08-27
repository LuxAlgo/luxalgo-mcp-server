# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's security advisory flow:

**[Report a vulnerability](https://github.com/LuxAlgo/luxalgo-mcp-server/security/advisories/new)**

Do not open a public issue for anything security-sensitive. We will acknowledge reports as quickly as we can and keep you informed as a fix progresses.

## Scope

This repository contains the MCP server only. Its hosted deployment is keyless and read-only; the local broker tools read credentials exclusively from environment variables you set in your own MCP client config, request read-only scopes, and never write secrets anywhere.

Vulnerabilities in LuxAlgo's websites or APIs (rather than this server's code) can also be reported through the channel above and will be routed to the right place.

## Supported versions

Only the latest published version of [`@luxalgo/mcp`](https://www.npmjs.com/package/@luxalgo/mcp) is supported with security fixes.

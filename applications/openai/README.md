# OpenAI plugin package

What we upload to OpenAI's plugin portal (platform.openai.com → Plugins → LuxAlgo → Upload new version).

- `plugin.json`: listing metadata, reviewer test cases, demo video URL, release notes.
- `mcp.json`: the MCP server's ChatGPT address, `https://mcp.luxalgo.com/mcp/openai` (a trimmed toolset; see docs/auth.md).
- `assets/logo.png`: the listing logo.

The demo walkthrough the reviewers watch is served by this deployment from `public/review/demo.mp4` (https://mcp.luxalgo.com/review/demo.mp4), since it has to be reachable by URL. Its prompts match the test cases in `plugin.json`.

Build the ZIP from this directory:

```bash
zip -rX ../../luxalgo-openai-plugin.zip plugin.json mcp.json assets
```

Reviewer test-account credentials are entered in the portal, never committed here.

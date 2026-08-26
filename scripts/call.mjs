/*
  Ad-hoc tool caller for manual testing: spins up the built server over
  stdio and calls one tool, printing the JSON result. With no arguments it
  lists the tools with their input schemas.

    node scripts/call.mjs                          # list tools
    node scripts/call.mjs propfirms_search '{"text":"ftmo"}'
*/
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [toolName, argsJson] = process.argv.slice(2);

const client = new Client({ name: "call", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"] }),
);

if (!toolName) {
  const { tools } = await client.listTools();
  for (const tool of tools) {
    console.log(`## ${tool.name} — ${tool.title ?? ""}`);
    console.log(tool.description ?? "");
    console.log(JSON.stringify(tool.inputSchema, null, 1));
    console.log();
  }
} else {
  const result = await client.callTool({
    name: toolName,
    arguments: argsJson ? JSON.parse(argsJson) : {},
  });
  if (result.isError) console.error("TOOL ERROR");
  console.log(result.content?.map((c) => c.text).join("\n") ?? "");
}

await client.close();

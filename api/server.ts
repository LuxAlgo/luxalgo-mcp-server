/*
  Vercel Functions entry — the hosted deployment when mcp.luxalgo.com
  lives on Vercel. `vercel.json` rewrites every path to this function and
  mcp-handler routes on the original URL, so clients still connect to
  /mcp (streamable HTTP). Same registerAllTools() as the stdio and
  plain-Node entries; stateless, no Redis needed.
*/
import { createMcpHandler } from "mcp-handler";
import { registerAllTools } from "../src/lib/register.js";

const handler = createMcpHandler(
  (server) => registerAllTools(server),
  {},
  { maxDuration: 60 },
);

export { handler as GET, handler as POST, handler as DELETE };

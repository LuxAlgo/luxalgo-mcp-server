/*
  Vercel Functions entry — the hosted deployment when mcp.luxalgo.com
  lives on Vercel. `vercel.json` rewrites every path to this function and
  mcp-handler routes on the original URL, so clients still connect to
  /mcp (streamable HTTP). Same registerLibraryTools() as the stdio and
  plain-Node entries; stateless, no Redis needed.
*/
import { createMcpHandler } from "mcp-handler";
import { registerLibraryTools } from "../src/lib/tools.js";

const handler = createMcpHandler(
  (server) => registerLibraryTools(server),
  {},
  { maxDuration: 60 },
);

export { handler as GET, handler as POST, handler as DELETE };

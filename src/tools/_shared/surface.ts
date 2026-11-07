/*
  Which answers a tool may give on the address the request came in on
  (auth/surface.ts picks it; read-only here).

  The Claude address is under directory review exactly as it was submitted:
  its tool definitions and results stay byte-identical until that review is
  done. Answer improvements (trimmed payloads, plain-language result text,
  honest refusals) therefore apply on the standard and OpenAI addresses and
  on stdio, never on the Claude one. Changes that only make a call faster,
  with the same output, apply everywhere.
*/
import { currentSurface } from "../../auth/surface.js";

/** True on the Claude address: keep tool definitions and results as reviewed. */
export function answersFrozen(): boolean {
  return currentSurface().kind === "claude";
}

/** True on the ChatGPT address (/mcp/openai), the only address some modules leave out entirely. */
export function onChatGptAddress(): boolean {
  return currentSurface().kind === "openai";
}

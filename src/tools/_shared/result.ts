/*
  Tool result builders shared by every domain. One implementation, so the
  wire shape is identical everywhere: results are compact JSON in text
  content (agents parse it fine and it keeps payloads small), and errors are
  `{ error }` JSON with `isError` so clients render them as failures rather
  than data.
*/
import type { CallToolResult } from "@modelcontextprotocol/server";
import { AppAuthError, AppPermissionError } from "../../platform/app-client.js";

/** A successful result carrying `payload` as compact JSON text. */
export function json(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** A failed result: `{ error: message }` as JSON text, flagged isError. */
export function toolError(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

/** Prose result with a structured twin — for tools whose text is meant to be read, not parsed. */
export function ok(text: string, structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

/** Plain-text failure (no JSON wrapping) for prose-style tools. */
export function textError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs `fn`, turning any throw into a tool error via `onError` (default:
 * the error message as `{ error }` JSON). Network and format failures thus
 * surface as clean tool results, never as raw exceptions the SDK stringifies.
 *
 * The app's "sign in" (401) and "plan does not allow" (403) answers are NOT
 * swallowed: they propagate to the auth wrapper around every tool, which
 * turns them into the challenge / upgrade results the client understands
 * (see docs/auth.md §6). Do the same in any hand-written catch block.
 */
export async function guarded(
  fn: () => CallToolResult | Promise<CallToolResult>,
  onError: (message: string) => CallToolResult = toolError,
): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AppAuthError || error instanceof AppPermissionError) throw error;
    return onError(errorMessage(error));
  }
}

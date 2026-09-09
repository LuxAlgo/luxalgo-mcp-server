/*
  The app's refusals, as tool results. This server never checks entitlements
  itself (its code is public; see access-context.ts): tools forward the
  user's token to the app and translate its answers —
    401 → sign-in challenge (AppAuthError)
    403 → "your plan does not allow this" (AppPermissionError).
  Any tool calling the app can hit these, so instrument.ts applies the
  mapping to every registered tool rather than each tool doing it.
*/
import { AppAuthError, AppPermissionError } from "../platform/app-client.js";
import { signInRequiredResult } from "./challenge.js";

export function appErrorResult(error: unknown, signInHint?: string) {
  if (error instanceof AppAuthError) {
    return signInRequiredResult(
      { error: "invalid_token", description: "Your LuxAlgo sign-in is missing or no longer valid. Sign in again." },
      signInHint,
    );
  }
  if (error instanceof AppPermissionError) {
    const which = error.permission ? ` (${error.permission})` : "";
    return {
      isError: true as const,
      content: [
        {
          type: "text" as const,
          text: `Your LuxAlgo plan does not include this${which}: ${error.message}. Upgrading at https://app.luxalgo.com/account/plan unlocks it.`,
        },
      ],
    };
  }
  return undefined;
}

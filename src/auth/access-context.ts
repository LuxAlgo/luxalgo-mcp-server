/*
  The caller's access token, made ambient for the duration of a tool call.

  This server decides nothing about entitlements — its code is public, so any
  check here could be deleted by whoever runs a copy. Instead every request a
  tool makes to the LuxAlgo app forwards the user's token, and the app's API
  routes read the user from it exactly as they do for a browser session: they
  answer 401 when a route needs a user and there is none, 403 when the plan
  does not allow something. A tampered copy of this server can only present
  the user's own token, so it can do no more than that user could.

  Rather than threading the token through every tool signature, the tools/call
  handler wraps each call in `runWithAccess`; `appGet` in platform/app-client.ts reads
  `currentAccess()` and adds the Authorization header when one is present.
  Public tools therefore forward a token too whenever the caller has one
  (hosted: the client's verified bearer; stdio: the local login store), which
  lets the app personalise or unlock content in routes where a user is
  optional — without any tool knowing.
*/
import { AsyncLocalStorage } from "node:async_hooks";

/** The caller's verified access: token to call the app with, plus who they are. */
export type Access = {
  token: string;
  userId?: string;
  email?: string;
};

const storage = new AsyncLocalStorage<Access | undefined>();

export function runWithAccess<T>(access: Access | undefined, fn: () => T): T {
  return storage.run(access, fn);
}

export function currentAccess(): Access | undefined {
  return storage.getStore();
}

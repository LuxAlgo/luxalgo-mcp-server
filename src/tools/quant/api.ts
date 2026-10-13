/*
  Typed wrappers over the app's signed-in Quant routes (`/api/quant/pine/*`).
  Both need a user on the app side, so the tools in this domain are protected;
  the token travels ambiently (auth/access-context.ts). They are POSTs because
  a script can run to 200,000 characters, so they go through appSend, always
  as the signed-in user.

  Shapes mirror the app's wire contract: the Quant API's `generation` and
  `validation` objects, billed to the user's plan usage instead of an API
  balance (`billed_to: "plan_usage"`, no `charged_usd` / `balance_usd`).
  Generation here always runs the `quant` model; there is no model choice on
  this route. The app answers 402 when the plan has no Quant usage left and
  429 when the user is rate limited; both arrive as errors carrying the app's
  own message.
*/
import { appSend } from "../../platform/app-client.js";

/** One linter finding. Lines and columns are 1-based; the column is absent when the linter has none. */
export type PineDiagnostic = { line: number; column?: number | null; message: string };

export type PineValidation = { valid: boolean; errors: PineDiagnostic[]; warnings: PineDiagnostic[] };

export type PineGeneration = {
  object: "generation";
  id: string;
  /** `working`: the code passes the linter with no errors (warnings allowed). `failed`: it does not. */
  status: "working" | "failed";
  /** Always `quant` on this route. */
  model: "quant";
  /** The script; on a failed generation the last attempt, or null when there was none. */
  code: string | null;
  title: string | null;
  script_type: "indicator" | "strategy" | null;
  validation: PineValidation;
  attempts: number;
  billed_to: "plan_usage";
};

export type PineValidationResult = PineValidation & { object: "validation" };

export const generatePine = (body: { prompt: string; code?: string }) =>
  appSend<PineGeneration>("POST", "/api/quant/pine/generate", { body });

export const validatePine = (code: string) =>
  appSend<PineValidationResult>("POST", "/api/quant/pine/validate", { body: { code } });

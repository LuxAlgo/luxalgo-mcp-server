/*
  Paper Trading by LuxAlgo for the signed-in member: their paper accounts on
  LuxAlgo's paper simulator, with simulated money. Never a broker, never live
  orders, never real money: the app reaches these tools only the member's
  paper accounts, and refuses anything else.

  Every change is two steps, and the member decides between them:

    paper_propose_order / paper_close_position / paper_cancel_order
        check the change and return it with a confirmation token; nothing
        changes. The model shows the member the exact order and waits for
        their explicit yes.
    paper_place_order
        carries it out with that token and the order restated (symbol, side,
        size). The token works once, for that order and that member, for a
        few minutes; the app refuses anything else. Marked destructive, so
        MCP hosts ask the user before it runs.

  Nothing about plans or permissions is decided here: the app answers.
  Results are plain words plus compact structured content; no advice.
*/
import { z } from "zod";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { registerProtectedTool } from "../../auth/protected-tool.js";
import type { AuthRuntime } from "../../auth/runtime.js";
import { AppApiError, AppAuthError, AppPermissionError } from "../../platform/app-client.js";
import { errorMessage, ok, textError } from "../_shared/result.js";
import {
  placeProposal,
  proposeCancel,
  proposeClose,
  proposeOrder,
  readPaperAccount,
  type PaperProposal,
  type Proposed,
} from "./api.js";

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;
/** A proposal changes nothing in the account: it is checked and held for the member's yes. */
const PROPOSE = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
/** Placing changes the member's paper account: hosts that honour annotations ask the user first. */
const PLACE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

const SIMULATED =
  "Paper Trading by LuxAlgo is LuxAlgo's paper simulator: simulated money, never a broker, never real money.";
const TWO_STEPS =
  "It changes nothing: it returns the exact order and a confirmation_token. Show the member the order in plain words (account, symbol, side, quantity, order type and price, the estimated cost) and wait for their explicit yes in their own words before calling paper_place_order. Never place an order the member did not approve, never approve on their behalf, and never chain this call and paper_place_order in one step.";
const NO_ADVICE = "This is a tool, not investment advice: do not recommend trades; carry out what the member asks.";
const NOT_OPEN =
  "Paper trading from an AI assistant is not open on this LuxAlgo account yet (the LuxAlgo app answered 404).";

const accountIdInput = z
  .string()
  .min(1)
  .max(128)
  .optional()
  .describe("One of the member's paper accounts, by id from paper_account. Default: their first paper account.");
const symbolInput = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .describe('The market as LuxAlgo paper trading names it, e.g. "BTCUSD", "AAPL", "EURUSD" or a futures contract "NQ1!".');
const noteInput = z
  .string()
  .max(500)
  .optional()
  .describe("Optional: why the member asked for it, in a few words, kept with the order's record.");

const money = (n: number | null | undefined): string =>
  n === null || n === undefined ? "unknown" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const num = (n: number | null | undefined): string =>
  n === null || n === undefined ? "unknown" : n.toLocaleString("en-US", { maximumFractionDigits: 8 });

/** The order in one sentence: "Buy 2 units of BTCUSD at market on Paper Trading by LuxAlgo". */
function orderWords(p: PaperProposal): string {
  if (p.action === "cancel") {
    const what = (p.cancels ?? []).map((c) => c.label).join("; ") || p.symbol;
    return `Cancel the working paper order ${what} on ${p.account.name}`;
  }
  const side = p.side === "sell" ? "Sell" : "Buy";
  const size = `${num(p.quantity)} ${p.unit ?? "units"} of ${p.symbol}`;
  if (p.action === "close") {
    const held = p.position ? ` (the ${p.position.direction} position of ${num(p.position.quantity)})` : "";
    return `${side} ${size} at market on ${p.account.name}, closing${held}`;
  }
  const how = p.type === "limit" ? `with a limit at ${num(p.price)}` : p.type === "stop" ? `on a stop at ${num(p.price)}` : "at market";
  const bracket = [
    p.stopLoss !== undefined && p.stopLoss !== null ? `stop loss ${num(p.stopLoss)}` : "",
    p.takeProfit && p.takeProfit.length > 0 ? `take profit ${p.takeProfit.map(num).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return `${side} ${size} ${how} on ${p.account.name}${bracket ? `, ${bracket}` : ""}`;
}

function costWords(p: PaperProposal): string {
  if (p.action !== "open") return p.estimatedPrice !== null ? ` The latest price is ${num(p.estimatedPrice)}.` : "";
  const parts = [
    p.estimatedPrice !== null ? `estimated price ${num(p.estimatedPrice)}` : "",
    p.estimatedValueUsd !== null && p.estimatedValueUsd !== undefined ? `estimated value ${money(p.estimatedValueUsd)}` : "",
    p.estimatedMarginUsd !== null && p.estimatedMarginUsd !== undefined ? `margin held about ${money(p.estimatedMarginUsd)}` : "",
    p.riskUsd !== null && p.riskUsd !== undefined ? `loss at the stop about ${money(p.riskUsd)}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? ` In simulated money: ${parts.join(", ")}.` : "";
}

/** The structured twin of a proposal, in snake case like the rest of this server's results. */
function proposalOut(p: PaperProposal) {
  return {
    id: p.id,
    action: p.action,
    status: p.status,
    simulated: true,
    account: p.account,
    symbol: p.symbol,
    ...(p.side ? { side: p.side } : {}),
    ...(p.type ? { order_type: p.type } : {}),
    quantity: p.quantity,
    unit: p.unit,
    ...(p.price !== undefined ? { price: p.price } : {}),
    estimated_price: p.estimatedPrice,
    ...(p.estimatedValueUsd !== undefined ? { estimated_value_usd: p.estimatedValueUsd } : {}),
    ...(p.estimatedMarginUsd !== undefined ? { estimated_margin_usd: p.estimatedMarginUsd } : {}),
    ...(p.stopLoss !== undefined ? { stop_loss: p.stopLoss } : {}),
    ...(p.takeProfit ? { take_profit: p.takeProfit } : {}),
    ...(p.riskUsd !== undefined ? { risk_usd: p.riskUsd } : {}),
    ...(p.cancels ? { cancels: p.cancels.map((c) => ({ order_id: c.orderId, label: c.label })) } : {}),
    warnings: p.warnings,
    expires_at: p.expiresAt,
    ...(p.statusReason ? { status_reason: p.statusReason } : {}),
    ...(p.orders ? { orders: p.orders } : {}),
  };
}

/** What paper_place_order must be called with, as the model reads it. */
function placeArgs(proposed: Proposed) {
  const p = proposed.proposal;
  return {
    confirmation_token: proposed.confirmationToken,
    symbol: p.symbol,
    ...(p.action !== "cancel" && p.side ? { side: p.side } : {}),
    ...(p.action !== "cancel" && p.quantity !== null ? { quantity: p.quantity } : {}),
  };
}

function proposedResult(proposed: Proposed): CallToolResult {
  const p = proposed.proposal;
  const warnings = p.warnings.length > 0 ? ` Note: ${p.warnings.join(" ")}` : "";
  const text =
    `Proposed, not placed: ${orderWords(p)}.${costWords(p)}${warnings} ` +
    `This is a paper order with simulated money. Show it to the member and ask for their yes; only then call paper_place_order with the place_with arguments. ` +
    `The confirmation token works once and expires at ${proposed.expiresAt}.`;
  return ok(text, { proposal: proposalOut(p), place_with: placeArgs(proposed), expires_at: proposed.expiresAt });
}

/** The app's refusals in words; sign-in and plan answers always go up to the auth wrapper. */
function failure(error: unknown, what: string): CallToolResult {
  if (error instanceof AppAuthError || error instanceof AppPermissionError) throw error;
  if (error instanceof AppApiError && error.status === 404 && /^Not available$/i.test(error.message)) {
    return textError(`${what}: ${NOT_OPEN}`);
  }
  if (error instanceof AppApiError && error.status === 429) {
    return textError(`${what}: too many requests for this account right now. Wait a minute and try again.`);
  }
  return textError(`${what}: ${errorMessage(error)}`);
}

export function registerPaperTools(server: McpServer, runtime: AuthRuntime) {
  registerProtectedTool(
    server,
    runtime,
    "paper_account",
    {
      title: "My paper trading account",
      description: `The signed-in member's Paper Trading by LuxAlgo accounts: each account's id, name, balance, equity, open and today's P&L and margin, the open positions, the working orders (with ids for paper_cancel_order) and the newest fills. ${SIMULATED} Read only. Use it before proposing an order, to see what is held and what is free. It shows no broker account; for those, the broker tools of a local install are read-only.`,
      inputSchema: z.object({}),
      annotations: READ,
    },
    async () => {
      try {
        const read = await readPaperAccount();
        const accounts = read.accounts
          .map(
            (a) =>
              `${a.name} (id ${a.id}): balance ${money(a.balance)}, equity ${money(a.equity)}, open P&L ${money(a.openPnl)}, margin free ${money(a.marginFree)}${a.approximate ? " (approximate: a price or contract value was missing)" : ""}`,
          )
          .join("; ");
        const positions =
          read.positions.length === 0
            ? "No open positions."
            : `Open positions: ${read.positions.map((p) => `${p.direction} ${num(p.quantity)} ${p.symbol} from ${num(p.avgEntry)}, last ${num(p.mark)}`).join("; ")}.`;
        const orders =
          read.openOrders.length === 0
            ? "No working orders."
            : `Working orders: ${read.openOrders.map((o) => `${o.side} ${num(o.quantity)} ${o.symbol} ${o.type}${o.limitPrice !== null ? ` at ${num(o.limitPrice)}` : o.stopPrice !== null ? ` at ${num(o.stopPrice)}` : ""} (id ${o.id})`).join("; ")}.`;
        const text = `Paper Trading by LuxAlgo, simulated money. ${accounts}. ${positions} ${orders} ${read.recentFills.length} recent fill${read.recentFills.length === 1 ? "" : "s"}.`;
        return ok(text, {
          simulated: true,
          accounts: read.accounts,
          positions: read.positions,
          open_orders: read.openOrders,
          recent_fills: read.recentFills,
        });
      } catch (error) {
        return failure(error, "Could not read the paper account");
      }
    },
  );

  registerProtectedTool(
    server,
    runtime,
    "paper_propose_order",
    {
      title: "Propose a paper order",
      description: `Proposes a new order on one of the member's Paper Trading by LuxAlgo accounts: market, limit or stop, an exact quantity, optionally a stop loss and a take profit. ${SIMULATED} The LuxAlgo app checks it as placing it would (the account's risk limits and kill switch included) and answers the estimated price, value and margin. ${TWO_STEPS} ${NO_ADVICE}`,
      inputSchema: z.object({
        symbol: symbolInput,
        side: z.enum(["buy", "sell"]),
        order_type: z.enum(["market", "limit", "stop"]).default("market"),
        quantity: z.number().positive().finite().describe("The exact size: shares, contracts or units of the market."),
        limit_price: z.number().positive().finite().optional().describe("Limit orders only: the limit price."),
        stop_price: z.number().positive().finite().optional().describe("Stop orders only: the price that triggers it."),
        stop_loss: z.number().positive().finite().optional().describe("Optional protective stop, as a price."),
        take_profit: z.number().positive().finite().optional().describe("Optional target, as a price."),
        account_id: accountIdInput,
        note: noteInput,
      }),
      annotations: PROPOSE,
    },
    async ({ symbol, side, order_type, quantity, limit_price, stop_price, stop_loss, take_profit, account_id, note }) => {
      try {
        return proposedResult(
          await proposeOrder({
            symbol,
            side,
            type: order_type,
            quantity,
            ...(limit_price !== undefined ? { limitPrice: limit_price } : {}),
            ...(stop_price !== undefined ? { stopPrice: stop_price } : {}),
            ...(stop_loss !== undefined ? { stopLoss: stop_loss } : {}),
            ...(take_profit !== undefined ? { takeProfit: take_profit } : {}),
            ...(account_id ? { accountId: account_id } : {}),
            ...(note ? { note } : {}),
          }),
        );
      } catch (error) {
        return failure(error, "Nothing was proposed");
      }
    },
  );

  registerProtectedTool(
    server,
    runtime,
    "paper_close_position",
    {
      title: "Propose closing a paper position",
      description: `Proposes closing one of the member's Paper Trading by LuxAlgo positions at market, all of it or a percent of it; its working exits are replaced as the close requires. ${SIMULATED} ${TWO_STEPS}`,
      inputSchema: z.object({
        symbol: symbolInput,
        percent: z.number().positive().max(100).optional().describe("How much of the position to close, in percent. Default: all of it."),
        account_id: accountIdInput,
        note: noteInput,
      }),
      annotations: PROPOSE,
    },
    async ({ symbol, percent, account_id, note }) => {
      try {
        return proposedResult(
          await proposeClose({
            symbol,
            ...(percent !== undefined ? { percent } : {}),
            ...(account_id ? { accountId: account_id } : {}),
            ...(note ? { note } : {}),
          }),
        );
      } catch (error) {
        return failure(error, "Nothing was proposed");
      }
    },
  );

  registerProtectedTool(
    server,
    runtime,
    "paper_cancel_order",
    {
      title: "Propose cancelling a paper order",
      description: `Proposes cancelling one working order on the member's Paper Trading by LuxAlgo accounts, by its id from paper_account. Cancelling a stop loss leaves the position without one, and the result says so. ${SIMULATED} ${TWO_STEPS}`,
      inputSchema: z.object({
        order_id: z.string().min(1).max(128).describe("The working order's id, from paper_account."),
        note: noteInput,
      }),
      annotations: PROPOSE,
    },
    async ({ order_id, note }) => {
      try {
        return proposedResult(await proposeCancel({ orderId: order_id, ...(note ? { note } : {}) }));
      } catch (error) {
        return failure(error, "Nothing was proposed");
      }
    },
  );

  registerProtectedTool(
    server,
    runtime,
    "paper_place_order",
    {
      title: "Place an approved paper order",
      description: `Carries out a paper proposal the member explicitly approved: the order from paper_propose_order, the close from paper_close_position or the cancel from paper_cancel_order. Call it only after you showed the member that exact proposal and they said yes in their own words; if they did not, ask them first. It takes the proposal's confirmation_token and the order restated (symbol; side and quantity for an order or a close), exactly as the proposal's place_with gives them. The token works once, for that order and that member, and expires after a few minutes: a changed order, a used or expired token, or no token is refused and nothing is placed, so propose again. ${SIMULATED} The LuxAlgo app places it on the paper simulator, where the account's risk limits and kill switch decide again, and answers how it went.`,
      inputSchema: z.object({
        confirmation_token: z.string().min(1).max(256).describe("The confirmation_token the proposal returned."),
        symbol: symbolInput,
        side: z.enum(["buy", "sell"]).optional().describe("The proposal's side; required for an order or a close."),
        quantity: z.number().positive().finite().optional().describe("The proposal's quantity; required for an order or a close."),
      }),
      annotations: PLACE,
    },
    async ({ confirmation_token, symbol, side, quantity }) => {
      try {
        const { proposal } = await placeProposal({
          confirmationToken: confirmation_token,
          symbol,
          ...(side ? { side } : {}),
          ...(quantity !== undefined ? { quantity } : {}),
        });
        const done = proposal.status === "executed";
        const fills = (proposal.orders ?? [])
          .filter((o) => o.filledQuantity > 0)
          .map((o) => `${o.side} ${num(o.filledQuantity)} ${o.symbol} at ${num(o.filledAvgPrice)}`);
        const outcome = done
          ? proposal.action === "cancel"
            ? "Canceled"
            : fills.length > 0
              ? `Placed and filled (${fills.join("; ")})`
              : "Placed; it is working on the paper simulator"
          : "Not placed";
        const text = `${outcome}: ${orderWords(proposal)}. Simulated money on Paper Trading by LuxAlgo.${proposal.statusReason ? ` ${proposal.statusReason}` : ""}`;
        const result = ok(text, { proposal: proposalOut(proposal) });
        return done ? result : { ...result, isError: true };
      } catch (error) {
        return failure(error, "Nothing was placed");
      }
    },
  );
}

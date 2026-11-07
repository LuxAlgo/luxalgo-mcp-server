/*
  Typed wrappers over the LuxAlgo app's paper-trading routes for AI
  assistants. Every route needs a signed-in member and reaches only their own
  Paper Trading by LuxAlgo accounts (simulated money on LuxAlgo's paper
  simulator); the app checks that, not this server. Proposing changes
  nothing; only `place` does, and only with the confirmation token a proposal
  returned. The routes answer 404 while the app has them switched off.

  Shapes mirror the app's wire contracts.
*/
import { appGet, appSend } from "../../platform/app-client.js";

export type PaperAccount = {
  id: string;
  name: string;
  currency: "USD";
  startingBalance: number;
  balance: number;
  equity: number;
  openPnl: number;
  todayPnl: number | null;
  marginUsed: number;
  marginFree: number;
  openPositions: number;
  approximate: boolean;
};

export type PaperPosition = {
  accountId: string;
  symbol: string;
  direction: "long" | "short";
  quantity: number;
  avgEntry: number | null;
  mark: number | null;
  openPnl: number | null;
};

export type PaperOrder = {
  id: string;
  accountId: string;
  symbol: string;
  side: "buy" | "sell";
  type: string;
  quantity: number | null;
  filledQuantity: number;
  limitPrice: number | null;
  stopPrice: number | null;
  reduceOnly: boolean;
  status: string;
  placedAt: string;
};

export type PaperFill = {
  orderId: string;
  accountId: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  fee: number | null;
  at: string;
};

export type PaperAccountRead = {
  simulated: true;
  accounts: PaperAccount[];
  positions: PaperPosition[];
  openOrders: PaperOrder[];
  recentFills: PaperFill[];
};

export type PaperProposal = {
  id: string;
  action: "open" | "close" | "cancel";
  status: "pending" | "approved" | "executed" | "failed" | "rejected" | "superseded";
  account: { id: string; name: string };
  simulated: true;
  symbol: string;
  side?: "buy" | "sell";
  type?: "market" | "limit" | "stop";
  quantity: number | null;
  unit: string | null;
  price?: number | null;
  estimatedPrice: number | null;
  estimatedValueUsd?: number | null;
  estimatedMarginUsd?: number | null;
  stopLoss?: number | null;
  takeProfit?: number[];
  riskUsd?: number | null;
  position?: { direction: "long" | "short"; quantity: number; avgEntry: number | null };
  cancels?: { orderId: string; label: string }[];
  warnings: string[];
  expiresAt: string;
  statusReason?: string;
  orders?: {
    id: string;
    symbol: string;
    side: "buy" | "sell";
    type: string;
    status: string;
    quantity: number | null;
    filledQuantity: number;
    filledAvgPrice: number | null;
  }[];
};

export type Proposed = { proposal: PaperProposal; confirmationToken: string; expiresAt: string };

export const readPaperAccount = () => appGet<PaperAccountRead>("/api/agents/paper");

export const proposeOrder = (body: {
  accountId?: string;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop";
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  note?: string;
}) => appSend<Proposed>("POST", "/api/agents/paper/proposals/order", { body });

export const proposeClose = (body: { accountId?: string; symbol: string; percent?: number; note?: string }) =>
  appSend<Proposed>("POST", "/api/agents/paper/proposals/close", { body });

export const proposeCancel = (body: { orderId: string; note?: string }) =>
  appSend<Proposed>("POST", "/api/agents/paper/proposals/cancel", { body });

export const placeProposal = (body: { confirmationToken: string; symbol: string; side?: "buy" | "sell"; quantity?: number }) =>
  appSend<{ proposal: PaperProposal }>("POST", "/api/agents/paper/place", { body });

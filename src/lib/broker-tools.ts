/*
  The broker tools — read-only portfolio access over @luxalgo/broker-sdk
  (16 brokers & exchanges, the user's own keys). LOCAL (stdio) ENTRY ONLY:
  credentials come exclusively from environment variables in the user's own
  MCP client config, so these tools must never be registered on the hosted
  entries — a hosted process has no business holding anyone's broker keys.

  Nothing here can place, modify, or cancel an order: the SDK's root export
  has no trading endpoints at all (the write layer is a separate opt-in
  subpath this server deliberately does not import).

  Env var naming derives mechanically from each adapter's credential
  fields: BROKERS_<BROKER-ID>_<FIELD>, uppercased, dashes and camelCase to
  underscores — BROKERS_ALPACA_API_KEY, BROKERS_OKX_PASSPHRASE,
  BROKERS_HYPERLIQUID_WALLET_ADDRESS, …
*/
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  connect,
  listBrokers,
  type Account,
  type BrokerConnection,
  type BrokerCredentials,
  type BrokerId,
  type BrokerSnapshot,
} from "@luxalgo/broker-sdk";
import { computeStats } from "@luxalgo/broker-sdk/stats";

const CACHE_MAX_AGE_MS = 5 * 60 * 1000;

export function envVarName(brokerId: string, credentialKey: string): string {
  const broker = brokerId.toUpperCase().replace(/-/g, "_");
  const field = credentialKey.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
  return `BROKERS_${broker}_${field}`;
}

/** Every supported broker with its env var names (never values) and state. */
function describeBrokers(env: NodeJS.ProcessEnv) {
  return listBrokers().map((broker) => {
    const envVars: Record<string, boolean> = {};
    for (const field of broker.credentials) {
      const name = envVarName(broker.id, field.key);
      envVars[name] = Boolean(env[name]?.trim());
    }
    return {
      id: broker.id,
      displayName: broker.displayName,
      readOnlySetup: broker.readOnlySetup,
      envVars,
      configured: Object.values(envVars).every(Boolean),
    };
  });
}

/** Open a connection for every broker whose env vars are all present. */
export function connectionsFromEnv(env: NodeJS.ProcessEnv): BrokerConnection[] {
  const connections: BrokerConnection[] = [];
  for (const broker of listBrokers()) {
    const credentials: Record<string, string> = {};
    let complete = true;
    for (const field of broker.credentials) {
      const value = env[envVarName(broker.id, field.key)]?.trim();
      if (!value) {
        complete = false;
        break;
      }
      credentials[field.key] = value;
    }
    if (!complete) continue;
    connections.push(
      connect({ broker: broker.id as BrokerId, credentials: credentials as BrokerCredentials[BrokerId] }),
    );
  }
  return connections;
}

type FetchFailure = { broker: string; label: string; message: string };
type SnapshotSet = { snapshots: BrokerSnapshot[]; failures: FetchFailure[] };

/*
  In-memory snapshot cache: tools read the cache; a fetch happens on first
  use, when the cache goes stale, or on broker_refresh. Concurrent calls
  share one in-flight sweep. Nothing is ever written to disk.
*/
function createPortfolioState(connections: BrokerConnection[]) {
  let cache: (SnapshotSet & { fetchedAt: number }) | null = null;
  let inFlight: Promise<SnapshotSet> | null = null;

  async function fetchAll(): Promise<SnapshotSet> {
    const settled = await Promise.allSettled(connections.map((c) => c.fetchSnapshot()));
    const snapshots: BrokerSnapshot[] = [];
    const failures: FetchFailure[] = [];
    settled.forEach((result, index) => {
      const connection = connections[index];
      if (!connection) return;
      if (result.status === "fulfilled") {
        snapshots.push(result.value);
      } else {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        failures.push({ broker: connection.broker, label: connection.label, message });
      }
    });
    cache = { snapshots, failures, fetchedAt: Date.now() };
    return { snapshots, failures };
  }

  function refresh(): Promise<SnapshotSet> {
    inFlight ??= fetchAll().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    snapshots: async (): Promise<SnapshotSet> => {
      if (cache && Date.now() - cache.fetchedAt < CACHE_MAX_AGE_MS) {
        return { snapshots: cache.snapshots, failures: cache.failures };
      }
      return refresh();
    },
    refresh,
  };
}

function allAccounts(snapshots: BrokerSnapshot[]): (Account & { broker: string })[] {
  return snapshots.flatMap((s) => s.accounts.map((a) => ({ ...a, broker: s.broker })));
}

function json(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

export function registerBrokerTools(server: McpServer, env: NodeJS.ProcessEnv = process.env) {
  const state = createPortfolioState(connectionsFromEnv(env));

  server.registerTool(
    "broker_setup",
    {
      title: "Broker connection setup & status",
      description:
        "Every broker this server can connect to (16 brokers & exchanges via @luxalgo/broker-sdk), the environment variables its credentials go in, whether each is set in this session (never the values), and the one-line guide to creating each key with read-only scope. Call this first when no broker data comes back, or when the user asks how to connect an account.",
      inputSchema: {},
    },
    async () => json(describeBrokers(env)),
  );

  server.registerTool(
    "broker_accounts",
    {
      title: "List connected brokerage accounts",
      description:
        "All connected accounts across every configured broker: stable id, name, broker, currency, total equity, and cash when reported. Uses a short-lived cache; call broker_refresh for live numbers. Read-only — this server cannot trade.",
      inputSchema: {},
    },
    async () => {
      const { snapshots, failures } = await state.snapshots();
      return json({
        accounts: allAccounts(snapshots).map(({ positions, trades, ...account }) => ({
          ...account,
          positions: positions.length,
          trades: trades.length,
        })),
        fetchedAt: snapshots[0]?.fetchedAt ?? null,
        failures,
      });
    },
  );

  server.registerTool(
    "broker_positions",
    {
      title: "Open positions",
      description:
        "Open positions across all connected accounts: symbol, quantity (negative means short), market value in the account currency when the broker prices it, plus asset class and average entry price where reported. Optionally filter by broker id.",
      inputSchema: {
        broker: z.string().optional().describe("Broker id to filter by, e.g. 'alpaca' or 'kraken'"),
      },
    },
    async ({ broker }) => {
      const { snapshots, failures } = await state.snapshots();
      const accounts = allAccounts(snapshots).filter((a) => !broker || a.broker === broker);
      return json({
        positions: accounts.flatMap((account) =>
          account.positions.map((position) => ({
            ...position,
            broker: account.broker,
            accountId: account.id,
            currency: account.currency,
          })),
        ),
        failures,
      });
    },
  );

  server.registerTool(
    "broker_trades",
    {
      title: "Trade history",
      description:
        "Executed trades across all connected accounts (the most recent window each broker exposes), newest first. Optionally filter by broker id and/or symbol. To simulate prop-firm challenge odds from this history, pass this tool's JSON result (the {trades: [...]} object) straight into propfirms_simulate_trades as tradeLogText, with importRisk set to the risk taken per trade. Filter to one broker/account first when several are connected: mixed-account histories are refused rather than replayed as one equity curve.",
      inputSchema: {
        broker: z.string().optional().describe("Broker id to filter by"),
        symbol: z.string().optional().describe("Symbol to filter by, e.g. 'BTC' or 'AAPL'"),
        limit: z.number().int().positive().max(500).optional().describe("Max trades to return (default 100)"),
      },
    },
    async ({ broker, symbol, limit }) => {
      const { snapshots, failures } = await state.snapshots();
      const accounts = allAccounts(snapshots).filter((a) => !broker || a.broker === broker);
      const trades = accounts
        .flatMap((account) => account.trades.map((t) => ({ ...t, broker: account.broker, accountId: account.id })))
        .filter((t) => !symbol || t.symbol.toUpperCase() === symbol.toUpperCase())
        .sort((a, b) => (b.executedAt ?? "").localeCompare(a.executedAt ?? ""))
        .slice(0, limit ?? 100);
      return json({ trades, failures });
    },
  );

  server.registerTool(
    "broker_stats",
    {
      title: "Portfolio performance stats",
      description:
        "Computed performance across the whole portfolio: total equity, equity by broker, top positions, and FIFO-matched trade stats — win rate, average win/loss, realized PnL, per-symbol breakdown. Amounts stay in each account's native currency, so mixed-currency totals are approximate. For prop-firm challenge odds from these stats, feed winRate plus avgWin/avgLoss converted to R-multiples (divide by the average amount risked per trade) into propfirms_simulate; for odds that respect the real trade sequence, use broker_trades with propfirms_simulate_trades instead.",
      inputSchema: {},
    },
    async () => {
      const { snapshots, failures } = await state.snapshots();
      return json({
        stats: computeStats(allAccounts(snapshots)),
        failures,
        disclaimer:
          "Informational only, not investment advice. FIFO stats are computed from the trade history " +
          "each broker serves; verify important numbers against your broker's own statements.",
      });
    },
  );

  server.registerTool(
    "broker_refresh",
    {
      title: "Refresh broker data",
      description:
        "Bypass the 5-minute cache and re-fetch every configured broker right now. Returns per-broker success/failure.",
      inputSchema: {},
    },
    async () => {
      const { snapshots, failures } = await state.refresh();
      return json({
        refreshed: snapshots.map((s) => ({ broker: s.broker, fetchedAt: s.fetchedAt, accounts: s.accounts.length })),
        failures,
      });
    },
  );
}

/*
  What Hyperliquid lists, so chart_open can answer in words when the model
  asks for a market Hyperliquid does not have ("AAPL", "ES", "EURUSD"): the
  chart view would otherwise open an empty chart. Server only (the view never
  bundles this file).

  Read from Hyperliquid's public info API, the same keyless calls Vela's
  provider makes in the browser (meta, perpDexs and each HIP-3 dex's meta):
  market names only, never prices or candles. No sign-in and no user data are
  involved, so the answer is cached in this process for a few minutes. Any
  failure answers null and the caller opens the chart as it did before.
*/

const INFO_URL = "https://api.hyperliquid.xyz/info";
const TIMEOUT_MS = 3_000;
const TTL_MS = 10 * 60_000;
const FAILED_TTL_MS = 30_000;
/** At most this many HIP-3 dexes are read (there are about ten). */
const MAX_DEXES = 40;

export type HyperliquidListing = {
  /** Main-dex perpetuals, upper-cased ("BTC", "KPEPE"). */
  perps: ReadonlySet<string>;
  /** Live HIP-3 perpetuals by upper-cased coin ("TSLA" → ["xyz:TSLA", "flx:TSLA"]), as Hyperliquid spells them. */
  hip3ByCoin: ReadonlyMap<string, readonly string[]>;
  /** Live HIP-3 perpetuals, upper-cased ("XYZ:TSLA"). */
  hip3: ReadonlySet<string>;
  /** False when the HIP-3 dexes could not be read: then nothing is known about them. */
  hip3Known: boolean;
};

type Meta = { universe?: Array<{ name?: string; isDelisted?: boolean }> };

async function post(body: unknown): Promise<unknown> {
  const res = await fetch(INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Hyperliquid answered ${res.status}`);
  return res.json();
}

const liveNames = (meta: unknown): string[] =>
  ((meta as Meta)?.universe ?? []).filter((u) => typeof u?.name === "string" && !u.isDelisted).map((u) => u.name as string);

async function readHip3(): Promise<Pick<HyperliquidListing, "hip3ByCoin" | "hip3">> {
  const dexes = await post({ type: "perpDexs" });
  const names = (Array.isArray(dexes) ? dexes : [])
    .map((d) => (d && typeof d === "object" ? (d as { name?: unknown }).name : undefined))
    .filter((name): name is string => typeof name === "string" && /^[a-z0-9]{1,16}$/.test(name))
    .slice(0, MAX_DEXES);
  const lists = await Promise.all(names.map((dex) => post({ type: "meta", dex }).then(liveNames, () => [] as string[])));
  const hip3ByCoin = new Map<string, string[]>();
  const hip3 = new Set<string>();
  names.forEach((dex, i) => {
    for (const name of lists[i]) {
      if (!name.startsWith(`${dex}:`) || name.length <= dex.length + 1) continue;
      hip3.add(name.toUpperCase());
      const coin = name.slice(dex.length + 1).toUpperCase();
      hip3ByCoin.set(coin, [...(hip3ByCoin.get(coin) ?? []), name]);
    }
  });
  return { hip3ByCoin, hip3 };
}

async function read(): Promise<HyperliquidListing | null> {
  const [main, hip3] = await Promise.allSettled([post({ type: "meta" }), readHip3()]);
  if (main.status !== "fulfilled") return null;
  const perps = new Set(liveNames(main.value).map((name) => name.toUpperCase()));
  if (!perps.size) return null;
  return hip3.status === "fulfilled"
    ? { perps, ...hip3.value, hip3Known: true }
    : { perps, hip3ByCoin: new Map(), hip3: new Set(), hip3Known: false };
}

let cache: { until: number; listing: Promise<HyperliquidListing | null> } | undefined;

/** Hyperliquid's live perpetual names, cached; null when Hyperliquid could not be read. */
export function hyperliquidListing(): Promise<HyperliquidListing | null> {
  const now = Date.now();
  if (cache && now < cache.until) return cache.listing;
  const listing = read().catch(() => null);
  const entry = { until: now + TTL_MS, listing };
  cache = entry;
  void listing.then((value) => {
    if (!value && cache === entry) entry.until = Date.now() + FAILED_TTL_MS;
  });
  return listing;
}

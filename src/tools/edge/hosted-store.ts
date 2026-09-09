/*
  The hosted Edge Stats store: derived artifacts (a manifest plus every
  preset × symbol result envelope) that a nightly workflow in
  github.com/LuxAlgo/edge-stats publishes to a rolling public GitHub release.
  Read-only, keyless, and never raw bars.
*/
export const RELEASE_BASE = "https://github.com/LuxAlgo/edge-stats/releases/download/hosted-store";
const CACHE_MAX_AGE_MS = 30 * 60 * 1000;

export interface HostedSymbol {
  symbol: string;
  assetClass: string;
  adapter: string;
  tf: string;
  lastBar: string | null;
  sessions: { sessionKey: string; sessions: number; firstDay: string; lastDay: string }[];
}

export interface HostedPreset {
  id: string;
  version: number;
  title: string;
  category: string;
  summary: string;
  outcome: string;
  where: string | null;
  groupBy: string | null;
  params: unknown[];
}

export interface HostedManifest {
  builtAt: string;
  commit: string;
  engineVersion: string;
  symbols: HostedSymbol[];
  presets: HostedPreset[];
  source: string;
  note: string;
}

export type HostedResultRow =
  | { preset: string; symbol: string; result: Record<string, unknown> }
  | { preset: string; symbol: string; error: string };

export interface HostedData {
  manifest: HostedManifest;
  results: HostedResultRow[];
}

/*
  In-memory artifact cache: the release assets change once a night, so a
  warm serverless instance re-serves them for CACHE_MAX_AGE_MS and
  concurrent cold calls share one in-flight download.
*/
let cache: (HostedData & { fetchedAt: number }) | null = null;
let inFlight: Promise<HostedData> | null = null;

async function fetchAsset(name: string): Promise<unknown> {
  const res = await fetch(`${RELEASE_BASE}/${name}`, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(
      `the hosted Edge Stats artifacts are not reachable (HTTP ${res.status} for ${name}). ` +
        "They publish nightly from the hosted-store workflow in github.com/LuxAlgo/edge-stats; " +
        "if this persists, the release may not have been built yet.",
    );
  }
  return res.json();
}

async function fetchHosted(): Promise<HostedData> {
  const [manifest, resultsPayload] = await Promise.all([
    fetchAsset("manifest.json"),
    fetchAsset("results.json"),
  ]);
  const data = {
    manifest: manifest as HostedManifest,
    results: (resultsPayload as { results: HostedResultRow[] }).results,
  };
  cache = { ...data, fetchedAt: Date.now() };
  return data;
}

export async function hostedData(): Promise<HostedData> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_MAX_AGE_MS) {
    return { manifest: cache.manifest, results: cache.results };
  }
  inFlight ??= fetchHosted().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

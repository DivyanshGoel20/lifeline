import { sellerIsPoor, sellerScore } from "./sellerQuality";

/**
 * Circle's agent marketplace, narrowed to what Lifeline can actually pay.
 *
 * The Discovery API lists x402 services across many chains. Lifeline pays through
 * Circle Gateway on Arc, so a listing only counts if it takes a Gateway-batched
 * payment there: anything else is shown to nobody, because buying it would fail.
 */
const DISCOVERY_URL = "https://api.circle.com/v2/x402/discovery/resources";
export const ARC_NETWORK = "eip155:5042002";
const GATEWAY_SCHEME_NAME = "GatewayWalletBatched";
const CACHE_MS = 60_000;
const USDC_DECIMALS = 1e6;

export type DiscoveryQuery = {
  query?: string;
  category?: string;
  maxUsd?: number;
  limit?: number;
};

export type MarketService = {
  url: string;
  method: string;
  description: string;
  provider: string;
  category: string | null;
  priceUsd: number;
  payTo: string;
  /** The seller also wants a wallet sign-in, which a plain purchase may not satisfy. */
  needsSignIn: boolean;
  input: unknown;
  output: unknown;
  quality: { score: number; samples: number; poor: boolean };
};

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

let fetcher: Fetcher = (url) => fetch(url, { signal: AbortSignal.timeout(15_000) });
/** Tests answer for the marketplace. */
export const useDiscoveryFetcher = (f: Fetcher | null) => {
  fetcher = f ?? ((url) => fetch(url, { signal: AbortSignal.timeout(15_000) }));
  cache.clear();
  known.clear();
};

// On globalThis so every route shares it (Next bundles routes apart).
const g = globalThis as unknown as {
  __lifelineDiscovery?: Map<string, { at: number; services: MarketService[]; total: number }>;
  __lifelineListings?: Map<string, MarketService>;
};
const cache = (g.__lifelineDiscovery ??= new Map());
const known = (g.__lifelineListings ??= new Map());

/** One marketplace item as Lifeline can use it, or null if it cannot be paid on Arc. */
export function toService(item: any): MarketService | null {
  const accept = (item?.accepts ?? []).find(
    (a: any) => a?.network === ARC_NETWORK && a?.extra?.name === GATEWAY_SCHEME_NAME && a?.scheme === "exact"
  );
  if (!accept || typeof item?.resource !== "string" || typeof accept.payTo !== "string") return null;
  const priceUsd = Number(accept.amount) / USDC_DECIMALS;
  if (!Number.isFinite(priceUsd) || priceUsd < 0) return null;

  const meta = item.metadata ?? {};
  const provider = meta.provider ?? {};
  return {
    url: item.resource,
    method: String(meta.method ?? "GET").toUpperCase(),
    description: String(meta.description ?? provider.description ?? ""),
    provider: String(provider.name ?? "Unknown"),
    category: provider.category ?? null,
    priceUsd,
    payTo: accept.payTo,
    needsSignIn: meta.siwx === true,
    input: meta.input ?? null,
    output: meta.output ?? null,
    quality: { ...sellerScore(accept.payTo), poor: sellerIsPoor(accept.payTo) },
  };
}

/**
 * Best first: sellers with a poor record last, then those that need no sign-in,
 * then the better record, then the cheaper.
 */
export function rankServices(services: MarketService[]): MarketService[] {
  return [...services].sort(
    (a, b) =>
      Number(a.quality.poor) - Number(b.quality.poor) ||
      Number(a.needsSignIn) - Number(b.needsSignIn) ||
      b.quality.score - a.quality.score ||
      a.priceUsd - b.priceUsd
  );
}

export async function discoverServices(q: DiscoveryQuery = {}, now = Date.now()) {
  const limit = Math.min(Math.max(q.limit ?? 20, 1), 100);
  const params = new URLSearchParams({ network: ARC_NETWORK, supportsCircleGateway: "true", limit: "200" });
  if (q.query) params.set("query", q.query);
  if (q.category) params.set("category", q.category);
  if (q.maxUsd !== undefined) params.set("maxUsdPrice", String(q.maxUsd));

  const url = `${DISCOVERY_URL}?${params}`;
  let entry = cache.get(url);
  if (!entry || now - entry.at > CACHE_MS) {
    const res = await fetcher(url);
    if (!res.ok) throw new Error(`The marketplace answered ${res.status}`);
    const body = await res.json();
    const services = (body.items ?? []).map(toService).filter(Boolean) as MarketService[];
    for (const s of services) known.set(s.url, s);
    entry = { at: now, services, total: Number(body.pagination?.total ?? services.length) };
    cache.set(url, entry);
  }
  // Scores change between fetches, so they are read fresh even from the cache.
  const fresh = entry.services.map((s: MarketService) => ({ ...s, quality: { ...sellerScore(s.payTo), poor: sellerIsPoor(s.payTo) } }));
  return { total: entry.total, services: rankServices(fresh).slice(0, limit) };
}

/** A listing seen recently: the source of the output format a purchase is checked against. */
export const listingFor = (url: string): MarketService | null => known.get(url) ?? null;

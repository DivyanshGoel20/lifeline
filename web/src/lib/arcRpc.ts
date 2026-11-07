import { http } from "viem";
import { ARC_IS_MAINNET, ARC_RPC_URL } from "./arc";

/**
 * Every Arc RPC call goes through here.
 *
 * Arc's public endpoints rate-limit hard and are shared with everyone. One dashboard
 * load makes dozens of reads, and retrying them all against the same endpoint turned a
 * two-second transaction into a ninety-second one, and could fail a draw halfway. So:
 *   - a rate-limited endpoint rests while the others take over;
 *   - only a few calls run at once, with transactions ahead of reads;
 *   - identical reads share one answer for a moment. Any write clears those answers.
 */
const PUBLIC_ENDPOINTS = ARC_IS_MAINNET
  ? ["https://rpc.mainnet.arc.io", "https://rpc.drpc.mainnet.arc.io", "https://rpc.quicknode.mainnet.arc.io", "https://rpc.blockdaemon.mainnet.arc.io"]
  : ["https://rpc.testnet.arc.io", "https://rpc.drpc.testnet.arc.io", "https://rpc.quicknode.testnet.arc.io", "https://rpc.blockdaemon.testnet.arc.io"];

/** A configured endpoint is tried first. */
export const arcEndpoints = () => [...new Set([ARC_RPC_URL, ...PUBLIC_ENDPOINTS])];

const MAX_CONCURRENT = 4;
const MAX_ATTEMPTS = 10;
const REST_MS = 6_000;
const READ_TTL_MS = 2_500;
const CACHEABLE = new Set(["eth_call", "eth_getBalance", "eth_blockNumber", "eth_getCode", "eth_chainId", "eth_gasPrice", "eth_getLogs"]);
const WRITES = new Set(["eth_sendRawTransaction", "eth_sendTransaction"]);
const THROTTLED = /Request exceeds defined limit|rate limit|limit exceeded|Too Many Requests/i;

type Shared = {
  restingUntil: Map<string, number>;
  active: number;
  waiting: (() => void)[];
  urgent: (() => void)[];
  answers: Map<string, { at: number; text: string }>;
  inFlight: Map<string, Promise<string>>;
};
// On globalThis: Next bundles routes apart, and the limits are per process.
const g = globalThis as unknown as { __lifelineArcRpc?: Shared };
const shared = (): Shared =>
  (g.__lifelineArcRpc ??= { restingUntil: new Map(), active: 0, waiting: [], urgent: [], answers: new Map(), inFlight: new Map() });

/** Tests start clean. */
export const resetArcRpc = () => {
  delete g.__lifelineArcRpc;
};

/** The endpoint to use now: the first that is not resting, or whichever rests least. */
export function healthyArcEndpoint(now = Date.now()): string {
  const s = shared();
  const list = arcEndpoints();
  return list.find((u) => (s.restingUntil.get(u) ?? 0) <= now) ?? [...list].sort((a, b) => (s.restingUntil.get(a) ?? 0) - (s.restingUntil.get(b) ?? 0))[0];
}

/** Someone's transaction goes ahead of a dashboard's reads. */
async function withSlot<T>(urgent: boolean, fn: () => Promise<T>): Promise<T> {
  const s = shared();
  if (s.active >= MAX_CONCURRENT) await new Promise<void>((resolve) => (urgent ? s.urgent : s.waiting).push(resolve));
  s.active++;
  try {
    return await fn();
  } finally {
    s.active--;
    (s.urgent.shift() ?? s.waiting.shift())?.();
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function send(body: string, urgent: boolean, headers: HeadersInit | undefined, signal: AbortSignal | null | undefined): Promise<string> {
  const s = shared();
  let lastError: unknown = new Error("Arc RPC did not answer.");
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const url = healthyArcEndpoint();
    const resting = (s.restingUntil.get(url) ?? 0) - Date.now();
    if (resting > 0) await pause(Math.min(resting, 3_000));
    try {
      const text = await withSlot(urgent, async () => {
        const res = await fetch(url, { method: "POST", headers, body, signal: signal ?? undefined });
        const answer = await res.text();
        if (res.status === 429 || res.status === 503 || THROTTLED.test(answer.slice(0, 500))) {
          throw Object.assign(new Error(`Arc RPC throttled (${res.status})`), { throttled: true });
        }
        if (!res.ok && !answer) throw new Error(`Arc RPC answered ${res.status}`);
        return answer;
      });
      return text;
    } catch (err: any) {
      if (err?.name === "AbortError") throw err;
      lastError = err;
      s.restingUntil.set(url, Date.now() + (err?.throttled ? REST_MS : REST_MS / 3));
    }
  }
  throw lastError;
}

/** What viem calls instead of fetch. The URL it passes is ignored, as this picks the endpoint. */
export async function arcFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const s = shared();
  const body = typeof init?.body === "string" ? init.body : "";
  let parsed: any = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    /* not JSON: sent as it is */
  }
  const method: string | undefined = parsed && !Array.isArray(parsed) ? parsed.method : undefined;
  const respond = (text: string) => new Response(text, { status: 200, headers: { "Content-Type": "application/json" } });

  if (method && WRITES.has(method)) s.answers.clear();
  if (!method || !CACHEABLE.has(method)) return respond(await send(body, true, init?.headers, init?.signal));

  // The request id differs each time, and the answer must carry the caller's.
  const key = JSON.stringify([method, parsed.params]);
  const withId = (text: string) => {
    try {
      return respond(JSON.stringify({ ...JSON.parse(text), id: parsed.id }));
    } catch {
      return respond(text);
    }
  };
  const fresh = s.answers.get(key);
  if (fresh && Date.now() - fresh.at < READ_TTL_MS) return withId(fresh.text);

  let pending = s.inFlight.get(key);
  if (!pending) {
    pending = send(body, false, init?.headers, null)
      .then((text) => {
        // An error is not worth repeating to the next caller.
        if (!/"error"\s*:/.test(text)) s.answers.set(key, { at: Date.now(), text });
        return text;
      })
      .finally(() => s.inFlight.delete(key));
    s.inFlight.set(key, pending);
  }
  return withId(await pending);
}

export function getArcTransport() {
  return http(ARC_RPC_URL, { fetchFn: arcFetch as typeof fetch, retryCount: 1, retryDelay: 1000, timeout: 60_000 });
}

/**
 * Intercepta risk screening for Arc x402 payments.
 *
 * Every Arc payment Lifeline makes is screened before anything is signed, and
 * every payment Lifeline's sellers take is screened before it is settled. The
 * verdict decides what happens next: pay, refuse, pay only up to a cap, or
 * hold for the human who owns the line.
 *
 * Arc is not a chain Intercepta scores, but an EVM address is the same
 * address everywhere, and a sanctioned wallet on Ethereum is not made clean by
 * paying on a testnet. So addresses are screened against Intercepta's mainnet
 * data, and the Gateway authorisation is scanned as the typed data it is
 * (Arc's domain and all), under a supported chain id.
 *
 * No key, or no answer, is never a pass: an unscreened payment is held.
 *
 * Framework-free so the Express seller in premium-api can use it as well.
 */

const BASE = (process.env.INTERCEPTA_API_URL || "https://api.web3antivirus.io").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.INTERCEPTA_TIMEOUT_MS || 8000);
// The free key is 1,000 requests. A counterparty's record does not change
// between two payments a minute apart, so answers are reused for a while.
const CACHE_MS = Number(process.env.INTERCEPTA_CACHE_MS || 5 * 60 * 1000);
// Scan Message has no Arc chain id. The typed data keeps Arc's domain; this
// only says which chain's rules to read it by.
const MESSAGE_CHAIN_ID = Number(process.env.INTERCEPTA_MESSAGE_CHAIN_ID || 8453);

/** Arc testnet's native USDC, the only asset an Arc Gateway quote should name. */
export const ARC_USDC = "0x3600000000000000000000000000000000000000";

/**
 * A payee with a known record, for showing a refusal: one of Intercepta's
 * pinned test addresses, scored 100 as a known scammer holding attack money.
 */
export const DEMO_RISKY_PAYTO =
  process.env.INTERCEPTA_DEMO_PAYTO || "0x39308ae43e5dda98db5fb17d005c5c764e5a2fed";

/**
 * A lookalike "USD Coin" (symbol USDC) on Ethereum, for showing the token
 * check: Intercepta rates it high risk, malicious, action block - FAKE_TOKEN,
 * KNOWN_MALICIOUS, SUSPICIOUS_DEPLOYER.
 */
export const DEMO_FAKE_USDC = process.env.INTERCEPTA_DEMO_FAKE_TOKEN || "0x740192316891b06aeddF20c741aBFC76d4CbECB0";

/** Clean counterparty: the agent pays on its own up to this much a payment. */
export const AUTO_APPROVE_USD = Number(process.env.INTERCEPTA_AUTO_APPROVE_USD || 0.4);
/** Counterparty with warning signs: capped at this much, above it a human decides. */
export const ELEVATED_CAP_USD = Number(process.env.INTERCEPTA_ELEVATED_CAP_USD || 0.1);

const SEVERE_SCORE = Number(process.env.INTERCEPTA_SEVERE_SCORE || 70);
const ELEVATED_SCORE = Number(process.env.INTERCEPTA_ELEVATED_SCORE || 30);

// Traits that end the conversation, whatever the score says.
const SEVERE_TRAITS = new Set([
  "sanction_address",
  "known_scammer",
  "blacklist",
  "initiator_scam_transactions",
  "attack_money_target",
  "fake_phishing_transfer",
  "rug_pull",
  "zero_address_risk",
]);

export type Level = "clean" | "elevated" | "severe" | "unknown";
export type Decision = "pay" | "cap" | "hold" | "refuse";

export interface Trait {
  name: string;
  risk: number;
  txsCount: number;
  description: string;
}

export interface Check {
  subject: "payTo" | "payer" | "token" | "authorization" | "history";
  target: string;
  endpoint: string;
  level: Level;
  summary: string;
  score?: number;
  traits?: Trait[];
  detectors?: { code: string; description: string }[];
  cached?: boolean;
  ms?: number;
}

export interface Verdict {
  decision: Decision;
  /** Plain sentences, most serious first. What the UI shows. */
  reasons: string[];
  /** The most this counterparty may be paid without a human, in USD. */
  capUsd: number;
  amountUsd: number;
  checks: Check[];
  screenedAt: number;
  provider: "intercepta" | "lifeline";
}

export class InterceptaError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export const isConfigured = () => Boolean(process.env.INTERCEPTA_API_KEY);

const cache = new Map<string, { at: number; value: unknown }>();

async function call<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  opts: { fresh?: boolean } = {}
): Promise<{ data: T; cached: boolean; ms: number }> {
  const key = process.env.INTERCEPTA_API_KEY;
  if (!key) throw new InterceptaError("INTERCEPTA_API_KEY is not set");

  const cacheKey = `${method} ${path} ${body ? JSON.stringify(body) : ""}`;
  const hit = cache.get(cacheKey);
  if (hit && !opts.fresh && Date.now() - hit.at < CACHE_MS) return { data: hit.value as T, cached: true, ms: 0 };

  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "X-API-KEY": key, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  } as RequestInit);
  const ms = Date.now() - started;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new InterceptaError(
      res.status === 403 ? "Intercepta refused the API key" : `Intercepta ${res.status}: ${text.slice(0, 160) || res.statusText}`,
      res.status
    );
  }
  const data = (await res.json()) as T;
  if (!opts.fresh) cache.set(cacheKey, { at: Date.now(), value: data });
  return { data, cached: false, ms };
}

/* ------------------------------------------------------------------------ */
/* Endpoints                                                                */
/* ------------------------------------------------------------------------ */

type ToxicScore = { toxicScore: number; traits: Trait[] };

/** Fast lookup, for the seller's hot path. */
export const quickScan = (address: string) =>
  call<ToxicScore>("GET", `/api/public/v2/extension/account/${address}/quick-scan`);

/** The full record: phishing, darkweb, laundering, sanctions exposure. */
export const deepScan = (address: string) =>
  call<ToxicScore>("GET", `/api/public/v2/extension/account/${address}/toxic-score`);

/** Who an address is: age, activity, what funded it, whether it is a contract. */
export const overview = (address: string) =>
  call<Record<string, any>>("GET", `/api/public/v1/extension/security/${address}/overview`);

export type TokenRisk = {
  riskScore?: number;
  riskLevel?: "neutral" | "low" | "medium" | "high";
  category?: string;
  trust?: "whitelist" | "blocklist" | "neutral";
  action?: "block" | "warn" | "info";
  detectors?: { code: string; description: string }[];
  token?: { chainId: number; address: string; symbol?: string };
};

export const scanToken = (address: string, chainId: number) =>
  call<TokenRisk>("GET", `/api/public/v2/extension/token-intelligence/token/${address}/risks?chainId=${chainId}`);

export type MessageRisk = {
  domain?: { name?: string | null; chainId?: string | null; verifyingContract?: string | null };
  messageType?: string | null;
  riskGroup?: "Low" | "Medium" | "High";
  detectors?: { code: string; description: string }[];
  // Per-address detectors come back as bare codes, not {code, description}.
  addresses?: { address: string; type?: string; detectors?: (string | { code: string; description?: string })[] }[];
};

/**
 * Two things the reference does not say, found against the live API: the
 * typed data goes in as an object - sent as the JSON string the docs
 * describe, it is not parsed and comes back "Low" with nothing read - and
 * chainId is a string.
 */
export const scanMessage = (from: string, typedData: unknown, website: string) =>
  call<MessageRisk>(
    "POST",
    "/api/public/v2/extension/analysis/signature",
    {
      from,
      website,
      message: JSON.parse(JSON.stringify(typedData, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
      chainId: String(MESSAGE_CHAIN_ID),
    },
    { fresh: true } // what is being signed is always read live
  );

/**
 * Tell Intercepta an address is misclassified: malicious where it saw no
 * risk, or safe where it flagged one. Goes into their threat data, so only a
 * signed-in human files one (see /api/risk/report); never cached.
 */
export const reportAddress = (address: string, message: string) =>
  call<{ success?: boolean; message?: string }>(
    "POST",
    "/api/public/v2/extension/reports/address",
    { address, message },
    { fresh: true }
  );

/* ------------------------------------------------------------------------ */
/* Reading the answers                                                      */
/* ------------------------------------------------------------------------ */

const human = (name: string) => name.replace(/_/g, " ");
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function levelOf(score: ToxicScore): Level {
  const traits = score.traits ?? [];
  if (score.toxicScore >= SEVERE_SCORE || traits.some((t) => SEVERE_TRAITS.has(t.name))) return "severe";
  if (score.toxicScore >= ELEVATED_SCORE || traits.length > 0) return "elevated";
  return "clean";
}

function addressCheck(subject: "payTo" | "payer", address: string, endpoint: string, r: { data: ToxicScore; cached: boolean; ms: number }): Check {
  const level = levelOf(r.data);
  const traits = [...(r.data.traits ?? [])].sort((a, b) => b.risk - a.risk);
  const who = subject === "payTo" ? "Payee" : "Payer";
  const summary =
    level === "clean"
      ? `${who} ${short(address)} has no known risk (score ${r.data.toxicScore})`
      : `${who} ${short(address)}: ${traits.map((t) => human(t.name)).join(", ") || "high score"} (score ${r.data.toxicScore})`;
  return { subject, target: address, endpoint, level, summary, score: r.data.toxicScore, traits, cached: r.cached, ms: r.ms };
}

function failedCheck(subject: Check["subject"], target: string, endpoint: string, err: unknown): Check {
  const why = err instanceof Error ? err.message : String(err);
  return { subject, target, endpoint, level: "unknown", summary: `Could not screen ${subject === "authorization" ? "the authorisation" : short(target)}: ${why}` };
}

async function screenAddress(subject: "payTo" | "payer", address: string, deep: boolean): Promise<Check> {
  const endpoint = deep ? "toxic-score" : "quick-scan";
  try {
    return addressCheck(subject, address, endpoint, await (deep ? deepScan(address) : quickScan(address)));
  } catch (err) {
    return failedCheck(subject, address, endpoint, err);
  }
}

async function screenToken(asset: string): Promise<Check> {
  if (asset.toLowerCase() === ARC_USDC) {
    return { subject: "token", target: asset, endpoint: "allowlist", level: "clean", summary: "Asset is Arc's native USDC" };
  }
  // Not Arc's USDC is refusal enough. Intercepta says what it actually is, if
  // it knows the contract from a mainnet it scores.
  const check: Check = {
    subject: "token",
    target: asset,
    endpoint: "token-risks",
    level: "severe",
    summary: `Asset ${short(asset)} is not Arc's native USDC`,
  };
  for (const chainId of [1, 8453]) {
    try {
      const r = await scanToken(asset, chainId);
      if (!r.data?.token && !r.data?.detectors?.length) continue;
      check.detectors = r.data.detectors;
      check.cached = r.cached;
      check.ms = r.ms;
      const fake = (r.data.detectors ?? []).some((x) => x.code === "FAKE_TOKEN");
      check.summary = fake
        ? `Asset ${short(asset)} is a fake ${r.data.token?.symbol ?? "token"} - Intercepta: ${r.data.riskLevel ?? "?"} risk, ${r.data.category ?? "flagged"}, action ${r.data.action ?? "?"}`
        : `${check.summary} - Intercepta: ${r.data.token?.symbol ?? "unknown token"}, ${r.data.riskLevel ?? "?"} risk${r.data.category ? `, ${r.data.category}` : ""}`;
      break;
    } catch {
      /* the refusal stands without it */
    }
  }
  return check;
}

async function screenAuthorization(from: string, typedData: unknown, website: string): Promise<Check> {
  try {
    const r = await scanMessage(from, typedData, website);
    // An answer about a message it did not read is no answer.
    if (!r.data.messageType && !r.data.domain?.name) {
      return failedCheck("authorization", from, "analysis/signature", new InterceptaError("Intercepta could not read the authorisation"));
    }
    const detectors = r.data.detectors ?? [];
    const flagged = (r.data.addresses ?? []).flatMap((a) =>
      (a.detectors ?? []).map((d) => {
        const code = typeof d === "string" ? d : d.code;
        return { code, description: `${human(code.toLowerCase())} (${short(a.address)})` };
      })
    );
    const all = [...detectors, ...flagged];
    const level: Level = r.data.riskGroup === "High" ? "severe" : r.data.riskGroup === "Medium" || all.length ? "elevated" : "clean";
    return {
      subject: "authorization",
      target: from,
      endpoint: "analysis/signature",
      level,
      summary:
        level === "clean"
          ? `Authorisation reads as ${r.data.messageType ?? "a transfer"}, ${r.data.riskGroup ?? "Low"} risk`
          : `Authorisation flagged ${r.data.riskGroup ?? ""}: ${all.map((d) => d.description || d.code).join("; ")}`,
      detectors: all,
      cached: r.cached,
      ms: r.ms,
    };
  } catch (err) {
    return failedCheck("authorization", from, "analysis/signature", err);
  }
}

function decide(checks: Check[], amountUsd: number, autoApproveUsd: number): Verdict {
  const severe = checks.filter((c) => c.level === "severe");
  const unknown = checks.filter((c) => c.level === "unknown");
  const elevated = checks.filter((c) => c.level === "elevated");
  const capUsd = severe.length ? 0 : elevated.length ? Math.min(ELEVATED_CAP_USD, autoApproveUsd) : autoApproveUsd;

  let decision: Decision;
  const reasons: string[] = [];
  if (severe.length) {
    decision = "refuse";
    reasons.push(...severe.map((c) => c.summary));
  } else if (unknown.length) {
    decision = "hold";
    reasons.push(...unknown.map((c) => c.summary), "Nothing is paid unscreened, so a human decides.");
  } else if (amountUsd > capUsd) {
    decision = "hold";
    reasons.push(
      ...elevated.map((c) => c.summary),
      `$${amountUsd.toFixed(2)} is over the $${capUsd.toFixed(2)} this counterparty may be paid without you.`
    );
  } else {
    decision = elevated.length ? "cap" : "pay";
    reasons.push(
      ...(elevated.length
        ? [...elevated.map((c) => c.summary), `Allowed up to $${capUsd.toFixed(2)} a payment.`]
        : [checks.some((c) => c.subject === "payer") ? "No known risk on the payer." : "No known risk on the payee, the asset or the authorisation."])
    );
  }
  return { decision, reasons, capUsd, amountUsd, checks, screenedAt: Date.now(), provider: "intercepta" };
}

/* ------------------------------------------------------------------------ */
/* The two sides of a payment                                               */
/* ------------------------------------------------------------------------ */

/**
 * Before an agent's payment is signed: who is being paid, in what, and what
 * exactly is being signed. The typed data is the authorisation that will be
 * signed if this passes, not a reconstruction of it.
 */
export async function screenOutgoing(p: {
  from: string;
  payTo: string;
  asset: string;
  amountUsd: number;
  typedData: unknown;
  website: string;
  autoApproveUsd?: number;
}): Promise<Verdict> {
  if (!isConfigured()) {
    return decide([failedCheck("payTo", p.payTo, "-", new InterceptaError("INTERCEPTA_API_KEY is not set"))], p.amountUsd, 0);
  }
  const checks = await Promise.all([
    screenAddress("payTo", p.payTo, true),
    screenToken(p.asset),
    screenAuthorization(p.from, p.typedData, p.website),
  ]);
  return decide(checks, p.amountUsd, p.autoApproveUsd ?? AUTO_APPROVE_USD);
}

/**
 * Before a seller settles: is the money coming from somewhere it should not.
 * A seller cannot wait for a human mid-request, so anything short of a clean
 * or capped pass is a refusal.
 */
export async function screenIncoming(payer: string, amountUsd: number): Promise<Verdict> {
  if (!isConfigured()) {
    const v = decide([failedCheck("payer", payer, "-", new InterceptaError("INTERCEPTA_API_KEY is not set"))], amountUsd, 0);
    return { ...v, decision: "refuse" };
  }
  const check = await screenAddress("payer", payer, false);
  const v = decide([check], amountUsd, Number(process.env.INTERCEPTA_SELLER_AUTO_ACCEPT_USD || 100));
  return v.decision === "hold" ? { ...v, decision: "refuse" } : v;
}

/** A counterparty's standing, with the reasons, for the dashboard. */
export async function profile(address: string) {
  const [quick, deep, about] = await Promise.allSettled([quickScan(address), deepScan(address), overview(address)]);
  const scored = deep.status === "fulfilled" ? deep.value : quick.status === "fulfilled" ? quick.value : null;
  if (!scored) {
    const err = deep.status === "rejected" ? deep.reason : null;
    throw err instanceof Error ? err : new InterceptaError("Intercepta did not answer");
  }
  const check = addressCheck("payTo", address, deep.status === "fulfilled" ? "toxic-score" : "quick-scan", scored);
  const o = about.status === "fulfilled" ? about.value.data : null;
  return {
    address,
    level: check.level,
    score: check.score,
    traits: check.traits ?? [],
    quickScore: quick.status === "fulfilled" ? quick.value.data.toxicScore : undefined,
    overview: o
      ? {
          ens: o.ens ?? null,
          firstTxDate: o.firstTxDate ?? null,
          lastTxDate: o.lastTxDate ?? null,
          txCount: o.txCount ?? null,
          fundedBy: o.fundedBy ?? null,
          isContract: o.isContract ?? null,
          project: o.project ?? null,
        }
      : null,
    screenedAt: Date.now(),
  };
}

/** One line for a ledger memo or an HTTP refusal. */
export const verdictLine = (v: Verdict) => `Intercepta ${v.decision}: ${v.reasons[0] ?? ""}`;

/** Test hook: forget cached answers. */
export const clearCache = () => cache.clear();

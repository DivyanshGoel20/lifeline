import path from "path";
import { formatUnits, hexToSignature, verifyTypedData } from "viem";
import fs from "../storeFs";
import { writeJsonAtomic } from "../atomicWrite";
import {
  USDT_ABI,
  WC_CHAIN_ID,
  WC_NETWORK,
  WC_USDT,
  WC_USDT_DECIMALS,
  WC_USDT_DOMAIN,
  wcFacilityAddress,
  wcOperatorKey,
  wcPublicClient,
  wcWalletFor,
} from "./config";

/**
 * Lifeline's x402 facilitator for USDT on Whitechain.
 *
 * The payer signs an EIP-3009 authorisation and pays nothing else. This checks it and
 * submits it, so the payer never holds WBT. A relayer that pays for other people's
 * transactions is a thing to be drained, so it spends gas only on a payment that:
 *   - is USDT, to a merchant Lifeline has registered, within the size limits;
 *   - carries a valid, unexpired signature over funds the payer actually holds;
 *   - fits today's limits per payer, per merchant, and in total.
 * All of that is checked before a transaction exists, so a refused payment costs nothing.
 */
export type Authorization = {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
};
export type ExactPayload = { signature: `0x${string}`; authorization: Authorization };
export type PaymentPayload = { x402Version: number; scheme: string; network: string; payload: ExactPayload };
export type PaymentRequirements = {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
};
export type VerifyResult = { isValid: boolean; invalidReason?: string; payer?: string };
export type SettleResult = { success: boolean; errorReason?: string; transaction?: string; network: string; payer?: string };

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const wcDomain = () => ({ ...WC_USDT_DOMAIN, chainId: WC_CHAIN_ID, verifyingContract: WC_USDT });

const envNumber = (name: string, fallback: number) => {
  const raw = process.env[name];
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n >= 0 ? n : fallback;
};
export const relayerLimits = () => ({
  minPaymentUsd: envNumber("WHITECHAIN_MIN_PAYMENT_USD", 0.001),
  maxPaymentUsd: envNumber("WHITECHAIN_MAX_PAYMENT_USD", 5),
  /** Longest an authorisation may stay open: an old one should not be settled by surprise. */
  maxWindowSeconds: envNumber("WHITECHAIN_MAX_WINDOW_SECONDS", 3600),
  perPayerDaily: envNumber("WHITECHAIN_PAYER_DAILY_TXS", 50),
  perMerchantDaily: envNumber("WHITECHAIN_MERCHANT_DAILY_TXS", 200),
  totalDaily: envNumber("WHITECHAIN_RELAYER_DAILY_TXS", 500),
  /** Below this the relayer stops rather than run dry halfway through a payment. */
  minRelayerWbt: envNumber("WHITECHAIN_RELAYER_MIN_WBT", 0.0001),
});

/** Who the relayer will pay gas for: registered merchants, and repayments to the facility. */
export function registeredMerchants(): string[] {
  const list = (process.env.WHITECHAIN_MERCHANTS || process.env.SELLER_WALLET_ADDRESS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const facility = wcFacilityAddress();
  return facility ? [...list, facility.toLowerCase()] : list;
}

/* ---------------------------------------------------------------- daily usage */

type Usage = { day: string; total: number; payers: Record<string, number>; merchants: Record<string, number>; gasWei: string };
const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

function usageFile(): string {
  const c = [path.resolve(process.cwd(), "web", "data", "whitechain-relayer.json"), path.resolve(process.cwd(), "data", "whitechain-relayer.json")];
  for (const f of c) if (fs.existsSync(f)) return f;
  return fs.existsSync(path.resolve(process.cwd(), "web", "data")) ? c[0] : c[1];
}
export function relayerUsage(now = Date.now()): Usage {
  const blank: Usage = { day: today(now), total: 0, payers: {}, merchants: {}, gasWei: "0" };
  try {
    if (!fs.existsSync(usageFile())) return blank;
    const u = JSON.parse(fs.readFileSync(usageFile(), "utf8")) as Usage;
    return u.day === blank.day ? u : blank;
  } catch {
    return blank;
  }
}

/* ---------------------------------------------------------------- the chain */

/** Swappable so the rules can be tested without one. */
export type FacilitatorChain = {
  balanceOf(owner: string): Promise<bigint>;
  authorizationUsed(from: string, nonce: string): Promise<boolean>;
  isBlocked(owner: string): Promise<boolean>;
  relayerWbt(): Promise<number>;
  /** Fails, without spending anything, if the token would refuse. */
  simulate(p: ExactPayload): Promise<void>;
  submit(p: ExactPayload): Promise<{ txHash: string; gasWei: bigint }>;
};

const authorizationArgs = (p: ExactPayload) => {
  const { from, to, value, validAfter, validBefore, nonce } = p.authorization;
  const sig = hexToSignature(p.signature);
  const v = Number(sig.v ?? BigInt(27 + (sig.yParity ?? 0)));
  return [from, to, BigInt(value), BigInt(validAfter), BigInt(validBefore), nonce, v, sig.r, sig.s] as const;
};

const onChain: FacilitatorChain = {
  balanceOf: (owner) => wcPublicClient().readContract({ address: WC_USDT, abi: USDT_ABI, functionName: "balanceOf", args: [owner as `0x${string}`] }),
  authorizationUsed: (from, nonce) =>
    wcPublicClient().readContract({ address: WC_USDT, abi: USDT_ABI, functionName: "authorizationState", args: [from as `0x${string}`, nonce as `0x${string}`] }),
  isBlocked: (owner) => wcPublicClient().readContract({ address: WC_USDT, abi: USDT_ABI, functionName: "isBlocked", args: [owner as `0x${string}`] }),
  relayerWbt: async () => {
    const wallet = wcWalletFor(wcOperatorKey());
    return Number(formatUnits(await wcPublicClient().getBalance({ address: wallet.account.address }), 18));
  },
  simulate: async (p) => {
    await wcPublicClient().simulateContract({
      account: wcWalletFor(wcOperatorKey()).account,
      address: WC_USDT,
      abi: USDT_ABI,
      functionName: "transferWithAuthorization",
      args: authorizationArgs(p),
    });
  },
  submit: async (p) => {
    const hash = await wcWalletFor(wcOperatorKey()).writeContract({
      address: WC_USDT,
      abi: USDT_ABI,
      functionName: "transferWithAuthorization",
      args: authorizationArgs(p),
    });
    const receipt = await wcPublicClient().waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`The token refused it (${hash}).`);
    return { txHash: hash, gasWei: receipt.gasUsed * receipt.effectiveGasPrice };
  },
};

let chain: FacilitatorChain = onChain;
export const useFacilitatorChain = (c: FacilitatorChain | null) => {
  chain = c ?? onChain;
};

/* ---------------------------------------------------------------- verify and settle */

const refuse = (invalidReason: string, payer?: string): VerifyResult => ({ isValid: false, invalidReason, payer });
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Every check that costs no gas. A valid answer means the relayer would pay for it. */
export async function verifyPayment(payment: PaymentPayload, req: PaymentRequirements, now = Date.now()): Promise<VerifyResult> {
  const auth = payment?.payload?.authorization;
  const signature = payment?.payload?.signature;
  if (!auth || !signature) return refuse("malformed_payload");
  const payer = auth.from;

  if (payment.scheme !== "exact" || req.scheme !== "exact") return refuse("unsupported_scheme", payer);
  if (payment.network !== WC_NETWORK || req.network !== WC_NETWORK) return refuse("unsupported_network", payer);
  if (!same(req.asset, WC_USDT)) return refuse("unsupported_asset", payer);
  if (!same(auth.to, req.payTo)) return refuse("wrong_recipient", payer);

  let value: bigint;
  try {
    value = BigInt(auth.value);
    if (value < BigInt(req.maxAmountRequired)) return refuse("insufficient_amount", payer);
  } catch {
    return refuse("malformed_payload", payer);
  }

  const limits = relayerLimits();
  const usd = Number(formatUnits(value, WC_USDT_DECIMALS));
  if (usd < limits.minPaymentUsd) return refuse("below_minimum", payer);
  if (usd > limits.maxPaymentUsd) return refuse("above_maximum", payer);
  if (!registeredMerchants().includes(auth.to.toLowerCase())) return refuse("merchant_not_registered", payer);

  const seconds = Math.floor(now / 1000);
  if (Number(auth.validAfter) > seconds) return refuse("not_yet_valid", payer);
  if (Number(auth.validBefore) <= seconds + 5) return refuse("expired", payer);
  if (Number(auth.validBefore) - seconds > limits.maxWindowSeconds) return refuse("window_too_long", payer);

  const usage = relayerUsage(now);
  if (usage.total >= limits.totalDaily) return refuse("relayer_daily_limit", payer);
  if ((usage.payers[payer.toLowerCase()] ?? 0) >= limits.perPayerDaily) return refuse("payer_daily_limit", payer);
  if ((usage.merchants[auth.to.toLowerCase()] ?? 0) >= limits.perMerchantDaily) return refuse("merchant_daily_limit", payer);

  let signed = false;
  try {
    signed = await verifyTypedData({
      address: payer,
      domain: wcDomain(),
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: { ...auth, value, validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore) },
      signature,
    });
  } catch {
    return refuse("invalid_signature", payer);
  }
  if (!signed) return refuse("invalid_signature", payer);

  try {
    if (await chain.isBlocked(payer)) return refuse("payer_blocked", payer);
    if ((await chain.balanceOf(payer)) < value) return refuse("insufficient_funds", payer);
    if (await chain.authorizationUsed(payer, auth.nonce)) return refuse("authorization_already_used", payer);
  } catch (err: any) {
    return refuse(`chain_unavailable: ${err?.shortMessage ?? err?.message ?? "unknown"}`.slice(0, 120), payer);
  }
  return { isValid: true, payer };
}

function recordUsage(payer: string, merchant: string, gasWei: bigint, now = Date.now()) {
  const u = relayerUsage(now);
  u.total += 1;
  u.payers[payer.toLowerCase()] = (u.payers[payer.toLowerCase()] ?? 0) + 1;
  u.merchants[merchant.toLowerCase()] = (u.merchants[merchant.toLowerCase()] ?? 0) + 1;
  u.gasWei = (BigInt(u.gasWei) + gasWei).toString();
  writeJsonAtomic(usageFile(), u);
}

/** Verify, then pay the gas and put the payment on chain. */
export async function settlePayment(payment: PaymentPayload, req: PaymentRequirements, now = Date.now()): Promise<SettleResult> {
  const fail = (errorReason: string, payer?: string): SettleResult => ({ success: false, errorReason, network: WC_NETWORK, payer });
  const checked = await verifyPayment(payment, req, now);
  if (!checked.isValid) return fail(checked.invalidReason ?? "invalid", checked.payer);

  try {
    if ((await chain.relayerWbt()) < relayerLimits().minRelayerWbt) return fail("relayer_out_of_gas", checked.payer);
    await chain.simulate(payment.payload);
    const { txHash, gasWei } = await chain.submit(payment.payload);
    recordUsage(payment.payload.authorization.from, payment.payload.authorization.to, gasWei, now);
    return { success: true, transaction: txHash, network: WC_NETWORK, payer: checked.payer };
  } catch (err: any) {
    return fail(`settlement_failed: ${err?.shortMessage ?? err?.message ?? "unknown"}`.slice(0, 200), checked.payer);
  }
}

/** What the relayer has left, and what it has spent today. Public. */
export async function relayerStatus() {
  const usage = relayerUsage();
  const limits = relayerLimits();
  let address: string | null = null;
  let wbt: number | null = null;
  try {
    address = wcWalletFor(wcOperatorKey()).account.address;
    wbt = await chain.relayerWbt();
  } catch {
    /* shown as unknown */
  }
  return {
    address,
    wbt,
    settledToday: usage.total,
    gasTodayWbt: Number(formatUnits(BigInt(usage.gasWei), 18)),
    limits,
    merchants: registeredMerchants(),
  };
}

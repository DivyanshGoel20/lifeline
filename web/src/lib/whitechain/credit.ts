import crypto from "crypto";
import path from "path";
import { formatUnits, keccak256, parseUnits, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import fs from "../storeFs";
import { writeJsonAtomic } from "../atomicWrite";
import { getAgentPrivateKey, authorizeAgentSpend } from "../agentKeys";
import { computeProfileId } from "../facilityContract";
import { withLedgerLock } from "../ledgerLock";
import { CREDIT_TIERS, ORIGINATION_FEE_RATE } from "../reputationEngine";
import { USDT_ABI, WC_FACILITY_ABI, WC_NETWORK, WC_USDT, WC_USDT_DECIMALS, wcConfigured, wcFacilityAddress, wcOperatorKey, wcPublicClient, wcWalletFor } from "./config";
import { TRANSFER_WITH_AUTHORIZATION_TYPES, settlePayment, wcDomain, type Authorization, type PaymentPayload, type PaymentRequirements } from "./facilitator";
import { encodePayment } from "./seller";

/**
 * Credit on Whitechain: an agent with no USDT and no WBT can still buy.
 *
 * With enough USDT the agent signs for itself. Without it, Lifeline's treasury signs for
 * the whole price - one x402 payment has one payer - and the debt goes on the human's
 * line, on the Whitechain facility. Repaying is a signature too. The relayer pays all gas.
 */
export type WcDebt = {
  id: string;
  human: string;
  agent: string;
  resource: string;
  principalUsd: number;
  owedUsd: number;
  status: "open" | "settled";
  at: number;
  paymentTx: string;
  drawTx?: string;
  repayTxs: string[];
};
type Account = { repayments: number; firstAt?: number };
type Ledger = { debts: WcDebt[]; accounts: Record<string, Account> };

function ledgerFile(): string {
  const c = [path.resolve(process.cwd(), "web", "data", "whitechain-ledger.json"), path.resolve(process.cwd(), "data", "whitechain-ledger.json")];
  for (const f of c) if (fs.existsSync(f)) return f;
  return fs.existsSync(path.resolve(process.cwd(), "web", "data")) ? c[0] : c[1];
}
function readLedger(): Ledger {
  try {
    if (fs.existsSync(ledgerFile())) return JSON.parse(fs.readFileSync(ledgerFile(), "utf8"));
  } catch {
    /* an unreadable ledger reads as empty, as the other stores do */
  }
  return { debts: [], accounts: {} };
}
const saveLedger = (l: Ledger) => writeJsonAtomic(ledgerFile(), l);
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const DAY = 86_400_000;

/** The same tiers as the other rails. This rail charges no running interest, so fees do not count. */
export function wcLine(human: string, now = Date.now()) {
  const l = readLedger();
  const account = l.accounts[human] ?? { repayments: 0 };
  const days = account.firstAt ? (now - account.firstAt) / DAY : 0;
  const tier = [...CREDIT_TIERS].reverse().find((t) => account.repayments >= t.requiredRepaymentsCount && days >= t.requiredActiveDurationDays) ?? CREDIT_TIERS[0];
  const open = l.debts.filter((d) => d.human === human && d.status === "open");
  const owedUsd = round(open.reduce((n, d) => n + d.owedUsd, 0));
  return { limitUsd: tier.creditLimit, tierName: tier.name, repayments: account.repayments, owedUsd, headroomUsd: round(Math.max(0, tier.creditLimit - owedUsd)), open };
}
export const wcDebts = (human: string) => readLedger().debts.filter((d) => d.human === human);

/* ---------------------------------------------------------------- the chain */

export type WcCreditChain = {
  usdtBalance(address: string): Promise<number>;
  ensureProfile(human: string, agent: string, limitUsd: number): Promise<void>;
  recordDraw(human: string, agent: string, usd: number, reference: string): Promise<string>;
  recordRepay(human: string, agent: string, usd: number): Promise<string>;
};

const write = async (args: any) => {
  const hash = await wcWalletFor(wcOperatorKey()).writeContract(args);
  const receipt = await wcPublicClient().waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Whitechain transaction reverted (${hash}).`);
  return hash as string;
};
const units = (usd: number) => parseUnits(usd.toFixed(WC_USDT_DECIMALS), WC_USDT_DECIMALS);

const onChain: WcCreditChain = {
  usdtBalance: async (address) =>
    Number(formatUnits(await wcPublicClient().readContract({ address: WC_USDT, abi: USDT_ABI, functionName: "balanceOf", args: [address as `0x${string}`] }), WC_USDT_DECIMALS)),
  async ensureProfile(human, agent, limitUsd) {
    const address = wcFacilityAddress()!;
    const profileId = computeProfileId(human);
    const operator = wcWalletFor(wcOperatorKey()).account.address;
    const c = wcPublicClient();
    const remaining = await c.readContract({ address, abi: WC_FACILITY_ABI, functionName: "getRemainingCredit", args: [profileId] }).catch(() => null);
    const debt = await c.readContract({ address, abi: WC_FACILITY_ABI, functionName: "getOutstandingDebt", args: [profileId] }).catch(() => 0n);
    if (remaining === null || (remaining === 0n && debt === 0n)) {
      await write({ address, abi: WC_FACILITY_ABI, functionName: "createCreditProfile", args: [profileId, operator, profileId, units(limitUsd)] });
    } else if (remaining + debt !== units(limitUsd)) {
      await write({ address, abi: WC_FACILITY_ABI, functionName: "setCreditLimit", args: [profileId, units(limitUsd)] });
    }
    const known = await c.readContract({ address, abi: WC_FACILITY_ABI, functionName: "isAgentAuthorized", args: [profileId, agent as `0x${string}`] });
    if (!known) await write({ address, abi: WC_FACILITY_ABI, functionName: "authorizeAgent", args: [profileId, agent] });
  },
  recordDraw: (human, agent, usd, reference) =>
    write({
      address: wcFacilityAddress()!,
      abi: WC_FACILITY_ABI,
      functionName: "recordDrawdown",
      args: [computeProfileId(human), agent, units(usd), 1, keccak256(toHex(reference))],
    }),
  async recordRepay(human, agent, usd) {
    const address = wcFacilityAddress()!;
    const hash = await write({ address, abi: WC_FACILITY_ABI, functionName: "recordRepayment", args: [computeProfileId(human), agent, agent, units(usd)] });
    // Back to the treasury, so what was repaid can be lent again.
    await write({ address, abi: WC_FACILITY_ABI, functionName: "withdraw", args: [wcWalletFor(wcOperatorKey()).account.address, units(usd)] });
    return hash;
  },
};

let chain: WcCreditChain = onChain;
export const useWcCreditChain = (c: WcCreditChain | null) => {
  chain = c ?? onChain;
};

/* ---------------------------------------------------------------- signing */

export async function signAuthorization(privateKey: `0x${string}`, to: string, value: bigint, now = Date.now()): Promise<PaymentPayload> {
  const account = privateKeyToAccount(privateKey);
  const seconds = Math.floor(now / 1000);
  const authorization: Authorization = {
    from: account.address,
    to: to as `0x${string}`,
    value: value.toString(),
    validAfter: String(seconds - 60),
    validBefore: String(seconds + 300),
    nonce: `0x${crypto.randomBytes(32).toString("hex")}`,
  };
  const signature = await account.signTypedData({
    domain: wcDomain(),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: { ...authorization, value, validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
  });
  return { x402Version: 1, scheme: "exact", network: WC_NETWORK, payload: { signature, authorization } };
}

/* ---------------------------------------------------------------- buying */

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export type WcPurchase = {
  status: number;
  data: unknown;
  fundingSource: "AGENT_USDT" | "LIFELINE_CREDIT";
  amountUsd: number;
  borrowedUsd: number;
  owedUsd: number;
  paymentTx: string;
  drawTx?: string;
};

/** What the agent does when a seller says 402. Nothing here needs WBT from the agent. */
export async function buyOnWhitechain(
  p: { human: string; agent: string; url: string; /** A mandate's remaining cap, when an agent calls for itself. */ maxCreditUsd?: number },
  deps: { fetcher?: Fetcher; key?: (a: string) => `0x${string}` | null; allow?: (a: string, usd: number) => { ok: boolean; reason?: string } } = {}
): Promise<WcPurchase> {
  const { fetcher = fetch, key = getAgentPrivateKey as any, allow = authorizeAgentSpend } = deps;
  if (!wcConfigured()) throw new Error("Lifeline is not set up on Whitechain yet.");

  const quote = await fetcher(p.url, { signal: AbortSignal.timeout(20_000) });
  if (quote.status !== 402) {
    return { status: quote.status, data: await quote.json().catch(() => null), fundingSource: "AGENT_USDT", amountUsd: 0, borrowedUsd: 0, owedUsd: 0, paymentTx: "" };
  }
  const body = await quote.json().catch(() => null);
  const asked: PaymentRequirements | undefined = body?.accepts?.find((a: any) => a.scheme === "exact" && a.network === WC_NETWORK && a.asset?.toLowerCase() === WC_USDT.toLowerCase());
  if (!asked) throw new Error("That seller does not take USDT on Whitechain.");
  const value = BigInt(asked.maxAmountRequired);
  const price = Number(formatUnits(value, WC_USDT_DECIMALS));

  return withLedgerLock(p.human, async () => {
    const agentKey = key(p.agent);
    if (!agentKey) throw new Error("Lifeline does not hold this agent's key, so it cannot sign for it.");
    const allowed = allow(p.agent, price);
    if (!allowed.ok) throw new Error(`Lifeline will not sign for this agent: ${allowed.reason}`);

    const holds = await chain.usdtBalance(p.agent);
    const onCredit = holds < price;
    const owed = onCredit ? round(price * (1 + ORIGINATION_FEE_RATE)) : 0;

    if (onCredit) {
      if (p.maxCreditUsd !== undefined && owed > p.maxCreditUsd) {
        throw new Error(`That needs $${owed.toFixed(2)} of credit and this agent's mandate has $${p.maxCreditUsd.toFixed(2)} left.`);
      }
      const line = wcLine(p.human);
      if (owed > line.headroomUsd) {
        throw new Error(`That needs $${owed.toFixed(2)} of credit and $${line.headroomUsd.toFixed(2)} is left on the Whitechain line.`);
      }
      await chain.ensureProfile(p.human, p.agent, line.limitUsd);
    }

    const payment = await signAuthorization(onCredit ? wcOperatorKey() : agentKey, asked.payTo, value);
    const paid = await fetcher(p.url, { headers: { "X-PAYMENT": encodePayment(payment) }, signal: AbortSignal.timeout(90_000) });
    const data = await paid.json().catch(() => null);
    if (!paid.ok) throw new Error((data as any)?.error ?? `The seller answered ${paid.status}.`);

    const header = paid.headers.get("x-payment-response");
    let paymentTx = "";
    try {
      paymentTx = header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")).transaction ?? "" : "";
    } catch {
      /* kept empty: the purchase still happened */
    }

    let drawTx: string | undefined;
    if (onCredit) {
      const l = readLedger();
      l.accounts[p.human] ??= { repayments: 0 };
      l.accounts[p.human].firstAt ??= Date.now();
      const debt: WcDebt = {
        id: crypto.randomUUID(),
        human: p.human,
        agent: p.agent,
        resource: p.url,
        principalUsd: price,
        owedUsd: owed,
        status: "open",
        at: Date.now(),
        paymentTx,
        repayTxs: [],
      };
      l.debts.push(debt);
      saveLedger(l);
      // The money has moved, so the debt stands even if this chain write has to wait.
      try {
        drawTx = await chain.recordDraw(p.human, p.agent, owed, debt.id);
        const again = readLedger();
        const row = again.debts.find((d) => d.id === debt.id);
        if (row) row.drawTx = drawTx;
        saveLedger(again);
      } catch (err: any) {
        console.warn("[whitechain] Could not record the drawdown:", err?.shortMessage ?? err?.message ?? err);
      }
    }

    return {
      status: paid.status,
      data,
      fundingSource: onCredit ? "LIFELINE_CREDIT" : "AGENT_USDT",
      amountUsd: price,
      borrowedUsd: onCredit ? price : 0,
      owedUsd: owed,
      paymentTx,
      drawTx,
    };
  });
}

/* ---------------------------------------------------------------- repaying */

/** The agent signs; the relayer submits it to the facility. Oldest debts clear first. */
export async function repayOnWhitechain(
  p: { human: string; agent: string; amountUsd?: number },
  deps: {
    key?: (a: string) => `0x${string}` | null;
    settle?: (payment: PaymentPayload, req: PaymentRequirements) => Promise<{ success: boolean; errorReason?: string; transaction?: string }>;
  } = {}
) {
  const { key = getAgentPrivateKey as any, settle = settlePayment } = deps;
  const facility = wcFacilityAddress();
  if (!facility) throw new Error("Lifeline is not set up on Whitechain yet.");

  return withLedgerLock(p.human, async () => {
    const line = wcLine(p.human);
    if (!(line.owedUsd > 0)) throw new Error("Nothing is owed on Whitechain.");
    const amount = round(Math.min(p.amountUsd ?? line.owedUsd, line.owedUsd));
    if (!(amount > 0)) throw new Error("The amount must be positive.");

    const agentKey = key(p.agent);
    if (!agentKey) throw new Error("Lifeline does not hold this agent's key, so it cannot sign for it.");
    const holds = await chain.usdtBalance(p.agent);
    if (holds < amount) throw new Error(`The agent holds $${holds.toFixed(2)} USDT and is repaying $${amount.toFixed(2)}.`);

    const value = units(amount);
    const payment = await signAuthorization(agentKey, facility, value);
    const settled = await settle(payment, { scheme: "exact", network: WC_NETWORK, maxAmountRequired: value.toString(), asset: WC_USDT, payTo: facility });
    if (!settled.success || !settled.transaction) throw new Error(`The repayment did not settle: ${settled.errorReason ?? "unknown"}`);

    // The USDT has moved: book it here first, so a failed chain write cannot lose it.
    const l = readLedger();
    let left = amount;
    for (const d of l.debts.filter((x) => x.human === p.human && x.status === "open").sort((a, b) => a.at - b.at)) {
      if (left <= 0) break;
      const taken = Math.min(left, d.owedUsd);
      d.owedUsd = round(d.owedUsd - taken);
      left = round(left - taken);
      d.repayTxs.push(settled.transaction);
      if (d.owedUsd <= 0.000001) d.status = "settled";
    }
    l.accounts[p.human] ??= { repayments: 0 };
    l.accounts[p.human].repayments += 1;
    saveLedger(l);

    let recordTx: string | undefined;
    try {
      recordTx = await chain.recordRepay(p.human, p.agent, amount);
    } catch (err: any) {
      console.warn("[whitechain] Could not record the repayment:", err?.shortMessage ?? err?.message ?? err);
    }
    return { repaidUsd: amount, owedUsd: wcLine(p.human).owedUsd, paymentTx: settled.transaction, recordTx };
  });
}

/** Testnet only: Lifeline's treasury plays the agent's customer and pays it in USDT. */
export async function payAgentForWork(agent: string, usd: number): Promise<string> {
  return write({ address: WC_USDT, abi: USDT_ABI, functionName: "transfer", args: [agent, units(usd)] });
}

export const agentUsdt = (agent: string) => chain.usdtBalance(agent);

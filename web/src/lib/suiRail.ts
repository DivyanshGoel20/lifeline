import {
  agentKeypair,
  deployment,
  depositToPurse,
  facilityLiquidity,
  fromUnits,
  payOut,
  network,
  operatorKeypair,
  paySui,
  readObligation,
  readProfile,
  readPurse,
  resolveObligation,
  settleEarly,
  toUnits,
  walletUnits,
  type SuiPayResult,
  setBookStore,
} from "@lifeline/sui";
import storeFs, { usesRedis } from "./storeFs";
import { getAgentPrivateKey, authorizeAgentSpend } from "./agentKeys";
import { getSuiFacilityStats } from "./agentStore";
import { recordRepaymentInReputation } from "./reputationStore";
import { computeProfileId } from "./facilityContract";
import { recordPayment } from "./paymentStore";
import {
  defaultObligation,
  openRailDebt,
  railDebtsFor,
  settleObligation,
  unpaidObligations,
  unpaidRailDebts,
  unpaidRowsOf,
  railDebtsForObligation,
} from "./railDebt";
import { invalidateTelemetryCache } from "./telemetryCache";
import { withLedgerLock } from "./ledgerLock";
import { createHold } from "./holdStore";
import { OverSpendingCap, approvalCovers, capHoldVerdict } from "./spendingCap";
import { borrowingBlocked, enforceStanding } from "./standing";
import type { Verdict } from "./intercepta";
import type { Agent } from "@/types";


// Sui's book of obligations lives in a file too, and is kept with the other ledgers.
if (usesRedis()) {
  const BOOK = "/data/sui-agents.json";
  setBookStore({
    read: () => (storeFs.existsSync(BOOK) ? JSON.parse(storeFs.readFileSync(BOOK, "utf8")) : null),
    write: (book) => storeFs.writeLedger(BOOK, JSON.stringify(book)),
  });
}

/**
 * Lifeline's Sui rail, as the web app sees it.
 *
 * Policy lives here, mechanism in @lifeline/sui: this module decides whose line is
 * being spent and how much of it, then hands the payer a key and a ceiling.
 * Every draw is written into railDebt against the session human, so Arc and Sui
 * net against one limit.
 */

export const SUI_FEED_URL = process.env.SUI_SERVICE_URL || "http://localhost:4031";

export function suiExplorer(kind: "tx" | "object", id: string): string | null {
  const n = network();
  if (n === "localnet") return null;
  return `https://suiscan.xyz/${n}/${kind === "tx" ? "tx" : "object"}/${id}`;
}

export function suiConfigured(): boolean {
  return !!deployment() && !!process.env.SUI_PRIVATE_KEY;
}

/** Whether the rail can be used right now, and what the Sui feed sells. */
export async function suiStatus() {
  const d = deployment();
  if (!d || !process.env.SUI_PRIVATE_KEY) {
    return {
      rail: "sui" as const,
      configured: false,
      network: network(),
      sellerUp: false,
      resources: [],
      reason: !d ? "Lifeline is not deployed on this Sui network" : "SUI_PRIVATE_KEY is not set",
    };
  }

  const [liquidity, catalogue] = await Promise.all([
    facilityLiquidity().catch(() => null),
    fetch(`${SUI_FEED_URL}/catalogue`, { cache: "no-store", signal: AbortSignal.timeout(4000) })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);

  return {
    rail: "sui" as const,
    configured: true,
    network: d.network,
    packageId: d.packageId,
    facilityId: d.facilityId,
    coinType: d.coinType,
    liquidityUsd: liquidity === null ? null : fromUnits(liquidity),
    facilityLink: suiExplorer("object", d.facilityId),
    sellerUp: !!catalogue,
    base: SUI_FEED_URL,
    resources: catalogue?.resources ?? [],
  };
}

export const suiAddressFor = (agentAddress: string): string | null => {
  const key = getAgentPrivateKey(agentAddress);
  return key ? agentKeypair(key).toSuiAddress() : null;
};

/** What each agent holds and owes on Sui, for the dashboard. */
export async function withSuiState(agents: Agent[], human: string): Promise<Agent[]> {
  const debts = unpaidRailDebts(human);
  const configured = suiConfigured();
  return Promise.all(
    agents.map(async (a) => {
      // Arc agents have no Sui state: an agent belongs to one rail.
      if (a.rail !== "sui") return a;
      const suiAddress = suiAddressFor(a.address) ?? undefined;
      const suiDebt =
        Math.round(
          debts.filter((d) => d.agentAddress.toLowerCase() === a.address.toLowerCase()).reduce((n, d) => n + d.amountUsd, 0) * 10000
        ) / 10000;
      let suiWalletUsd: number | undefined;
      if (configured && suiAddress) {
        suiWalletUsd = await walletUnits(suiAddress).then(fromUnits).catch(() => undefined);
      }
      return { ...a, suiAddress, suiDebt, suiWalletUsd };
    })
  );
}

/** Buy something on Sui for an agent, on its human's line. */
export type SuiHeld = {
  success: false;
  status: 202;
  screening: Verdict;
  hold: { holdId: string; expiresAt: number };
  amount: string;
  borrowed: "0";
  data: null;
};

export async function payOnSui(args: {
  url: string;
  agent: Agent;
  human: string;
  capUsd?: number;
  /** A held payment the human approved: past the agent's cap, for this payee and price only. */
  approvedFor?: { payTo: string; amountUsd: number };
}): Promise<(SuiPayResult & { explorer?: string | null }) | SuiHeld> {
  // One Sui payment per human at a time: two first payments for one agent
  // used to open two purses, and the agent book kept only one of them. Keyed
  // apart from Arc's ledger lock - the rails are separate lines.
  return withLedgerLock(`sui:${args.human}`, () => payOnSuiNow(args));
}

async function payOnSuiNow(args: {
  url: string;
  agent: Agent;
  human: string;
  capUsd?: number;
  approvedFor?: { payTo: string; amountUsd: number };
}): Promise<(SuiPayResult & { explorer?: string | null }) | SuiHeld> {
  const key = getAgentPrivateKey(args.agent.address);
  if (!key) {
    throw new Error(
      "Lifeline holds no key for this agent, so it cannot sign on Sui. Authorize a new Sui agent from the dashboard."
    );
  }

  // Sui's own line: its limit and its debt. Nothing drawn on Arc counts here.
  const facility = getSuiFacilityStats(args.human);
  // In default, the line lends nothing until the default is cured.
  const lineBlocked = borrowingBlocked(args.human, "sui");
  const maxCreditUsd = Math.min(facility.availableCredit, args.capUsd ?? Number.POSITIVE_INFINITY);

  // This agent's spending cap, less what it already owes on Sui.
  const owedByAgent = unpaidRailDebts(args.human)
    .filter((d) => d.agentAddress.toLowerCase() === args.agent.address.toLowerCase())
    .reduce((n, d) => n + d.amountUsd, 0);
  const capLeft = Math.max(0, Math.round((args.agent.creditLimit - owedByAgent) * 1e6) / 1e6);

  let result: SuiPayResult;
  try {
    result = await paySui(args.url, {
      agentKey: key,
      profileId: computeProfileId(args.human),
      creditLimitUsd: facility.creditLimit,
      maxCreditUsd,
      approve: (amountUsd) => {
        const allowed = authorizeAgentSpend(args.agent.address, amountUsd);
        if (!allowed.ok) throw new Error(`Lifeline will not sign for this agent: ${allowed.reason}`);
      },
      // Borrowing past the agent's cap is the human's call: held, unless they
      // already approved exactly this payment.
      approveDraw: (drawUsd, quote) => {
        if (lineBlocked && drawUsd > 0) throw new Error(`Lifeline: ${lineBlocked}`);
        if (drawUsd > capLeft + 1e-9 && !approvalCovers(args.approvedFor, quote.payTo, quote.priceUsd)) {
          throw new OverSpendingCap(drawUsd, capLeft, quote.payTo, quote.priceUsd);
        }
      },
    });
  } catch (err) {
    if (!(err instanceof OverSpendingCap)) throw err;
    const verdict = capHoldVerdict(err.needUsd, err.capLeftUsd, err.priceUsd);
    const hold = createHold({
      human: args.human,
      agentAddress: args.agent.address,
      url: args.url,
      method: "GET",
      payTo: err.payTo,
      amountUsd: err.priceUsd,
      verdict,
      rail: "sui",
    });
    recordPayment({
      paymentId: `sui_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      agentAddress: args.agent.address,
      humanProfileId: args.human,
      sellerAddress: err.payTo,
      resourceUrl: args.url,
      requestedAmount: err.priceUsd.toFixed(6),
      agentGatewayBalance: "0",
      shortfall: err.needUsd.toFixed(6),
      fundingSource: "LIFELINE_FACILITY",
      drawdownId: null,
      status: "HELD",
      timestamp: Date.now(),
      rail: "sui",
      network: network(),
      memo: verdict.reasons[0],
      screening: { decision: "hold", reasons: verdict.reasons, capUsd: verdict.capUsd, holdId: hold.holdId },
    });
    invalidateTelemetryCache(args.human);
    return {
      success: false,
      status: 202,
      screening: verdict,
      hold: { holdId: hold.holdId, expiresAt: hold.expiresAt },
      amount: err.priceUsd.toFixed(6),
      borrowed: "0",
      data: null,
    };
  }

  const borrowed = Number(result.borrowed);
  if (result.fundingSource === "LIFELINE_CREDIT" && borrowed > 0 && result.obligationId) {
    openRailDebt({
      humanOwner: args.human,
      rail: "sui",
      agentAddress: args.agent.address,
      amountUsd: borrowed,
      obligationId: result.obligationId,
      resource: args.url,
      digest: result.digest,
    });
  }

  if (Number(result.amount) > 0) {
    recordPayment({
      paymentId: `sui_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      agentAddress: args.agent.address,
      humanProfileId: args.human,
      sellerAddress: result.payTo,
      resourceUrl: args.url,
      requestedAmount: result.amount,
      agentGatewayBalance: result.ownContribution,
      shortfall: result.borrowed,
      fundingSource: result.fundingSource === "LIFELINE_CREDIT" ? "LIFELINE_FACILITY" : "AGENT_WALLET",
      drawdownId: result.obligationId ?? null,
      status: "SUCCESS",
      timestamp: Date.now(),
      transactionId: result.digest,
      rail: "sui",
      network: network(),
      memo:
        result.fundingSource === "LIFELINE_CREDIT"
          ? `Drew ${result.borrowed} against obligation ${result.obligationId}, due ${new Date(result.dueMs!).toISOString()}`
          : "Paid from the agent's own coins on Sui",
    });
  }

  invalidateTelemetryCache(args.human);
  return { ...result, explorer: result.digest ? suiExplorer("tx", result.digest) : null };
}

/** The human's parked repayments, read back from chain. */
export async function obligationsFor(human: string) {
  const rows = railDebtsFor(human);
  const ids = [...new Set(rows.map((r) => r.obligationId))];

  const out = await Promise.all(
    ids.map(async (id) => {
      const mine = rows.filter((r) => r.obligationId === id);
      const unpaid = mine.filter((r) => r.status !== "settled");
      const ob = await readObligation(id).catch(() => null);
      const purse = ob ? await readPurse(ob.purseId).catch(() => null) : null;
      return {
        obligationId: id,
        agentAddress: mine[0].agentAddress,
        suiAgent: ob?.agent ?? null,
        status: ob?.status ?? "unknown",
        drawnUsd: ob ? fromUnits(ob.drawn) : mine.reduce((n, r) => n + r.amountUsd, 0),
        ceilingUsd: ob ? fromUnits(ob.ceiling) : null,
        owedUsd: Math.round(unpaid.reduce((n, r) => n + r.amountUsd, 0) * 10000) / 10000,
        dueMs: ob?.dueMs ?? null,
        purseId: ob?.purseId ?? null,
        purseUsd: purse ? fromUnits(purse.balance) : null,
        draws: mine.length,
        link: suiExplorer("object", id),
      };
    })
  );
  return out.sort((a, b) => (b.dueMs ?? 0) - (a.dueMs ?? 0));
}

/**
 * Repay before the date. The agent moves what the purse is short from its own
 * coins and settles, in one sponsored transaction it signs itself.
 */
export async function settleEarlyFor(human: string, obligationId: string) {
  const row = railDebtsFor(human).find((r) => r.obligationId === obligationId);
  if (!row) throw new Error("No such obligation on your line");

  const key = getAgentPrivateKey(row.agentAddress);
  if (!key) throw new Error("Lifeline holds no key for the agent that owes this");

  const ob = await readObligation(obligationId);
  if (ob.status === "settled" || ob.status === "closed") {
    creditSuiRecord(settleObligation(obligationId));
    return { alreadySettled: true, obligationId };
  }

  const [purse, profile] = await Promise.all([readPurse(ob.purseId), readProfile(ob.profileId)]);
  const owed = profile && profile.outstandingDebt < ob.drawn ? profile.outstandingDebt : ob.drawn;
  const deposit = owed > purse.balance ? owed - purse.balance : 0n;

  const agent = agentKeypair(key);
  if (deposit > 0n) {
    const held = await walletUnits(agent.toSuiAddress());
    if (held < deposit) {
      throw new Error(
        `The agent holds ${fromUnits(held).toFixed(6)} on Sui and needs ${fromUnits(deposit).toFixed(6)} more to settle`
      );
    }
  }

  const r = await settleEarly(agent, operatorKeypair(), { purseId: ob.purseId, obligationId, depositUnits: deposit });
  const closed = settleObligation(obligationId);
  creditSuiRecord(closed);
  invalidateTelemetryCache(human);
  // Curing a default puts the Sui line back.
  await enforceStanding(human).catch((err: any) => console.warn("[standing]", err?.message ?? err));
  return {
    obligationId,
    digest: r.digest,
    link: suiExplorer("tx", r.digest),
    settledUsd: closed.reduce((n, c) => n + c.amountUsd, 0),
  };
}

/**
 * A settled obligation counts on the human's Sui record, and only there: the
 * rails are separate lines. Once per obligation, however many draws it covered.
 */
function creditSuiRecord(closed: { humanOwner: string; createdAt: number; settledAt?: number }[]) {
  if (!closed.length) return;
  const first = Math.min(...closed.map((c) => c.createdAt));
  const days = Math.max(0, (closed[0].settledAt ?? Date.now()) - first) / 86_400_000;
  void recordRepaymentInReputation({ humanOwner: closed[0].humanOwner, interestPaid: 0, loanDurationDays: days, rail: "sui" }).catch(
    (err) => console.warn("[suiRail] Sui record update failed:", err?.message ?? err)
  );
}

/**
 * Close the books on what the chain has done - and, for anything due and
 * still open, do it: collection is open to anyone, and Lifeline is the party
 * that bothers to call it.
 */
export async function reconcileSui(human?: string) {
  const ids = unpaidObligations(human);
  const out = { checked: ids.length, settled: [] as string[], defaulted: [] as string[], pending: 0, unresolved: [] as { obligationId: string; reason: string }[] };

  for (const id of ids) {
    // Due, and the agent's earnings are in its wallet rather than its purse
    // (that is where a customer pays it): settle from the wallet first, so an
    // agent that can pay is not recorded as having defaulted.
    const settledFromWallet = await settleDueFromWallet(id).catch(() => false);
    if (settledFromWallet) {
      out.settled.push(id);
      continue;
    }
    const o = await resolveObligation(id, { collectIfDue: true });
    if (o.state === "settled") {
      creditSuiRecord(settleObligation(id));
      out.settled.push(id);
    } else if (o.state === "defaulted") {
      defaultObligation(id, o.reason);
      out.defaulted.push(id);
    } else if (o.state === "pending") {
      out.pending++;
    } else {
      // A chain that cannot answer is not evidence. Leave it open.
      out.unresolved.push({ obligationId: id, reason: o.reason });
    }
  }
  if (human) invalidateTelemetryCache(human);
  // Defaults recorded (or cured) here change the humans' standing.
  const touched = new Set([...out.defaulted, ...out.settled].flatMap((id) => unpaidRowsOf(id).concat(railDebtsForObligation(id)).map((r) => r.humanOwner)));
  if (human) touched.add(human);
  for (const h of touched) await enforceStanding(h).catch((err: any) => console.warn("[standing]", err?.message ?? err));
  return out;
}

/** Settle a due, open obligation from the agent's wallet, if it holds enough. */
async function settleDueFromWallet(obligationId: string): Promise<boolean> {
  const ob = await readObligation(obligationId);
  if (ob.status !== "open" || ob.dueMs > Date.now()) return false;
  const row = unpaidRowsOf(obligationId)[0];
  const key = row ? getAgentPrivateKey(row.agentAddress) : null;
  if (!row || !key) return false;
  const [purse, profile] = await Promise.all([readPurse(ob.purseId), readProfile(ob.profileId)]);
  const owed = profile && profile.outstandingDebt < ob.drawn ? profile.outstandingDebt : ob.drawn;
  const short = owed > purse.balance ? owed - purse.balance : 0n;
  const agent = agentKeypair(key);
  if (short > 0n && (await walletUnits(agent.toSuiAddress())) < short) return false;
  await settleEarlyFor(row.humanOwner, obligationId);
  return true;
}

/**
 * Test networks only: pay an agent in testnet USDC, standing in for a customer
 * paying it for its work. The only way an agent here earns what it repays.
 */
export async function payAgentForWork(agentAddress: string, usd: number) {
  const d = deployment();
  if (!d || network() === "mainnet") {
    throw new Error("Paying an agent for its work is a test-network stand-in for a real customer");
  }
  const to = suiAddressFor(agentAddress);
  if (!to) throw new Error("Lifeline holds no key for this agent, so it has no Sui address");
  // Testnet USDC from the operator (or demo dollars, on a demo-coin facility).
  const r = await payOut(operatorKeypair(), to, toUnits(usd));
  return { to, digest: r.digest, link: suiExplorer("tx", r.digest) };
}

/**
 * What a card repayment of one obligation pays for: what its purse is short
 * of the amount owed. Settling is all or nothing, and the agent's own coins
 * are left alone - the human is paying instead of the agent, not as well.
 */
export async function suiShortfall(human: string, obligationId: string) {
  const row = railDebtsFor(human).find((r) => r.obligationId === obligationId);
  if (!row) throw new Error("No such obligation on your line");
  if (!getAgentPrivateKey(row.agentAddress)) throw new Error("Lifeline holds no key for the agent that owes this");

  const ob = await readObligation(obligationId);
  const open = ob.status !== "settled" && ob.status !== "closed";
  const [purse, profile] = await Promise.all([readPurse(ob.purseId), readProfile(ob.profileId)]);
  const owed = profile && profile.outstandingDebt < ob.drawn ? profile.outstandingDebt : ob.drawn;
  const needed = owed > purse.balance ? owed - purse.balance : 0n;
  return { open, agentAddress: row.agentAddress, purseId: ob.purseId, owedUsd: fromUnits(owed), fundUsd: fromUnits(needed), fundUnits: needed };
}

/** The operator's own USDC on Sui: what card repayments are funded from. */
export const operatorReserveUsd = async () => fromUnits(await walletUnits(operatorKeypair().toSuiAddress()));

/**
 * A card repayment has cleared: the operator puts what the purse is short
 * straight into the purse - where the agent cannot spend it on anything else -
 * and the agent settles from it. Safe to retry: the shortfall is read again
 * each time, so money already in the purse is never sent twice.
 */
export async function fundAndSettleSui(human: string, obligationId: string, maxFundUnits: bigint) {
  const s = await suiShortfall(human, obligationId);
  if (!s.open) return { ...(await settleEarlyFor(human, obligationId)), fundedUsd: 0 };
  if (s.fundUnits > maxFundUnits) {
    throw new Error("The obligation grew after the payment was started; it was not charged for the difference.");
  }
  let fundedDigest: string | undefined;
  if (s.fundUnits > 0n) fundedDigest = (await depositToPurse(operatorKeypair(), s.purseId, s.fundUnits)).digest;
  const settled = await settleEarlyFor(human, obligationId);
  return { ...settled, fundedUsd: s.fundUsd, fundedDigest };
}

import { getAgentsByOwner } from "./agentStore";
import { getAllLoans } from "./loanStore";
import { getAllPayments } from "./paymentStore";
import { sellerIsPoor, sellerScore } from "./sellerQuality";
import { humanForWallet } from "./walletLinks";

/**
 * What protects the lender when borrowers do not repay.
 *
 * A ban stops one person coming back; it does nothing if everyone defaults at
 * once. These limits decide the most Lifeline can lose, and stop new lending by
 * themselves when losses start. Repaying is never affected.
 */
const DAY = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;

const envNumber = (name: string, fallback: number) => {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const riskLimits = () => ({
  /** The most that may be out on loan across everyone, at once. */
  poolCapUsd: envNumber("LIFELINE_POOL_CAP_USD", 100),
  /** The most that may be newly lent across everyone in a day. */
  dailyNewCreditUsd: envNumber("LIFELINE_DAILY_NEW_CREDIT_USD", 25),
  /** The most that may be lent to pay any one seller in a day. */
  sellerDailyUsd: envNumber("LIFELINE_SELLER_DAILY_USD", 5),
  /** Stop lending when this share of recent loans has gone unpaid past due. */
  breakerDefaultRate: envNumber("LIFELINE_BREAKER_DEFAULT_RATE", 0.2),
  /** ...once at least this many loans have fallen due, so one late loan does not trip it. */
  breakerMinLoans: envNumber("LIFELINE_BREAKER_MIN_LOANS", 10),
});

const owed = (l: { outstandingAmount?: number }) => l.outstandingAmount || 0;

export function riskStatus(now = Date.now()) {
  const limits = riskLimits();
  const loans = getAllLoans();
  const active = loans.filter((l) => l.status === "ACTIVE" && owed(l) > 0.0001);

  const outstandingUsd = active.reduce((n, l) => n + owed(l), 0);
  const lentTodayUsd = loans.filter((l) => l.borrowedAt > now - DAY).reduce((n, l) => n + l.amount, 0);

  // Of the loans that have fallen due recently, how many are still unpaid?
  const due = loans.filter((l) => l.dueAt && l.dueAt < now && l.dueAt > now - WINDOW_DAYS * DAY);
  const unpaid = due.filter((l) => l.status !== "SETTLED" && owed(l) > 0.0001);
  const defaultRate = due.length ? unpaid.length / due.length : 0;
  const breakerTripped = due.length >= limits.breakerMinLoans && defaultRate > limits.breakerDefaultRate;

  return {
    limits,
    outstandingUsd: round(outstandingUsd),
    lentTodayUsd: round(lentTodayUsd),
    loansDue: due.length,
    loansUnpaid: unpaid.length,
    defaultRate: Math.round(defaultRate * 10000) / 10000,
    breakerTripped,
  };
}

const round = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Is this seller the borrower themselves? Credit pays the seller, so a borrower
 * who runs a seller could turn a credit line into cash and walk away with it.
 */
export function isSelfDealing(human: string, seller: string): boolean {
  const s = seller.toLowerCase();
  if (s === human.toLowerCase()) return true;
  if (getAgentsByOwner(human).some((a) => a.address.toLowerCase() === s)) return true;
  const linked = humanForWallet(s);
  return !!linked && linked.toLowerCase() === human.toLowerCase();
}

/** What has been lent to pay this seller in the last day, across every borrower. */
export function lentToSellerToday(seller: string, now = Date.now()): number {
  const s = seller.toLowerCase();
  return getAllPayments()
    .filter(
      (p) =>
        p.status === "SUCCESS" &&
        p.fundingSource === "LIFELINE_FACILITY" &&
        (p.rail ?? "arc") === "arc" &&
        p.timestamp > now - DAY &&
        (p.sellerAddress || "").toLowerCase() === s
    )
    .reduce((n, p) => n + (Number(p.shortfall) || 0), 0);
}

/**
 * May Lifeline lend this much right now? Returns the reason if not, or null.
 * `seller` is left out for a direct draw, which has no seller to judge.
 */
export function creditRefusal(p: { human: string; amountUsd: number; seller?: string }, now = Date.now()): string | null {
  const status = riskStatus(now);
  const { limits } = status;

  if (status.breakerTripped) {
    return `Lifeline has paused new credit: ${status.loansUnpaid} of the last ${status.loansDue} loans due are unpaid. Repaying still works.`;
  }
  if (status.outstandingUsd + p.amountUsd > limits.poolCapUsd + 1e-9) {
    return `Lifeline's lending is at its limit ($${status.outstandingUsd.toFixed(2)} of $${limits.poolCapUsd.toFixed(2)} out on loan).`;
  }
  if (status.lentTodayUsd + p.amountUsd > limits.dailyNewCreditUsd + 1e-9) {
    return `Lifeline has reached its limit on new credit for today ($${limits.dailyNewCreditUsd.toFixed(2)}).`;
  }
  if (p.seller) {
    if (isSelfDealing(p.human, p.seller)) {
      return "This seller's address belongs to the borrower. Credit cannot be used to pay yourself.";
    }
    if (sellerIsPoor(p.seller)) {
      const { score, samples } = sellerScore(p.seller);
      return `This seller delivered on about ${Math.round(score * 100)}% of ${samples} purchases, so Lifeline will not lend to buy from it.`;
    }
    const today = lentToSellerToday(p.seller, now);
    if (today + p.amountUsd > limits.sellerDailyUsd + 1e-9) {
      return `Lifeline has reached today's credit limit for this seller ($${limits.sellerDailyUsd.toFixed(2)}).`;
    }
  }
  return null;
}

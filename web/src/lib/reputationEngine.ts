import { Loan } from "@/types";

export interface CreditTier {
  tierNumber: number;
  name: string;
  creditLimit: number; // in USDC
  requiredInterestPaid: number; // in USDC
  requiredActiveDurationDays: number; // in days
  requiredRepaymentsCount: number; // number of on-time settlements
  badgeColor: string;
}

/**
 * Deliberately small: a line is unsecured, so it starts at what one person can
 * afford to lose and grows only on a record of repaying. Anything larger is
 * backed by a deposit (see collateralStore).
 */
export const CREDIT_TIERS: CreditTier[] = [
  {
    tierNumber: 1,
    name: "Tier 1: Starter Line",
    creditLimit: 0.5,
    requiredInterestPaid: 0,
    requiredActiveDurationDays: 0,
    requiredRepaymentsCount: 0,
    badgeColor: "emerald",
  },
  {
    tierNumber: 2,
    name: "Tier 2: Growth Operator",
    creditLimit: 1,
    requiredInterestPaid: 0.01,
    requiredActiveDurationDays: 7,
    requiredRepaymentsCount: 3,
    badgeColor: "cyan",
  },
  {
    tierNumber: 3,
    name: "Tier 3: Autonomous Fleet",
    creditLimit: 2,
    requiredInterestPaid: 0.05,
    requiredActiveDurationDays: 14,
    requiredRepaymentsCount: 10,
    badgeColor: "violet",
  },
];

/** Sui draws carry no fee: its line grows on repayments and time alone. */
export const SUI_TIERS: CreditTier[] = CREDIT_TIERS.map((t) => ({ ...t, requiredInterestPaid: 0 }));

// Maximum loan term is strictly 7 days (168 hours)
export const MAX_LOAN_TERM_DAYS = 7;
export const MAX_LOAN_TERM_MS = MAX_LOAN_TERM_DAYS * 24 * 60 * 60 * 1000;

// Dual-Fee parameters
export const ORIGINATION_FEE_RATE = 0.01; // 1.0% flat upon drawdown
export const DAILY_INTEREST_RATE = 0.0005; // 0.05% per day

export interface LoanAccrualDetails {
  principal: number;
  originationFee: number;
  accruedInterest: number;
  totalDue: number;
  daysOutstanding: number;
  dueTimestamp: number;
  isOverdue: boolean;
  isDueSoon: boolean;
  hoursRemaining: number;
}

/**
 * Calculates origination fee, daily interest accrual, and maturity timeline for a loan.
 */
export function calculateLoanAccrual(loan: Loan, asOfTimestamp = Date.now()): LoanAccrualDetails {
  const principal = loan.amount || loan.outstandingAmount || 0;
  const originationFee =
    loan.originationFee !== undefined
      ? loan.originationFee
      : Math.round(principal * ORIGINATION_FEE_RATE * 10000) / 10000;

  const borrowedAt = loan.borrowedAt || asOfTimestamp;
  const elapsedMs = Math.max(0, asOfTimestamp - borrowedAt);
  const daysOutstanding = elapsedMs / (24 * 60 * 60 * 1000);

  // baseDebt is the unpaid balance (which already incorporates upfront origination fee)
  const baseDebt =
    loan.outstandingAmount !== undefined
      ? loan.outstandingAmount
      : Math.round((principal + originationFee) * 10000) / 10000;

  // Daily interest, on what is still owed, since interest was last folded
  // into the balance. Charging the full principal from the day it was
  // borrowed, on every repayment, billed the same days twice and left a
  // residue that reappeared after the loan was paid.
  const accrualFrom = Math.max(borrowedAt, loan.accruedThrough ?? borrowedAt);
  const accrualDays = Math.max(0, asOfTimestamp - accrualFrom) / (24 * 60 * 60 * 1000);
  const interestBase = Math.min(principal, baseDebt);
  const accruedInterest =
    Math.round(interestBase * DAILY_INTEREST_RATE * accrualDays * 10000) / 10000;
  const totalDue = Math.round((baseDebt + accruedInterest) * 10000) / 10000;

  const dueTimestamp = loan.dueAt || (borrowedAt + MAX_LOAN_TERM_MS);
  const msRemaining = dueTimestamp - asOfTimestamp;
  const hoursRemaining = Math.round(msRemaining / (60 * 60 * 1000));
  const isOverdue = msRemaining <= 0 && baseDebt > 0.0001;
  const isDueSoon = msRemaining > 0 && msRemaining <= 48 * 60 * 60 * 1000 && baseDebt > 0.0001;

  return {
    principal,
    originationFee,
    accruedInterest,
    totalDue,
    daysOutstanding,
    dueTimestamp,
    isOverdue,
    isDueSoon,
    hoursRemaining,
  };
}

export interface ReputationSummary {
  humanOwner: string;
  currentTier: CreditTier;
  nextTier: CreditTier | null;
  reputationScore: number; // 0 to 100
  totalBorrowed: number;
  totalRepaid: number;
  totalInterestPaid: number;
  totalActiveDurationDays: number;
  repaymentsCount: number;
  oldestActiveLoan: {
    loanId: string;
    agentAddress: string;
    dueTimestamp: number;
    hoursRemaining: number;
    isOverdue: boolean;
    isDueSoon: boolean;
    totalDue: number;
  } | null;
  tierProgress: {
    interestProgressPct: number;
    durationProgressPct: number;
    repaymentProgressPct: number;
    overallProgressPct: number;
  };
}

/**
 * Computes human reputation, credit tier, and loan tranches from loan history.
 */
export function computeHumanReputation(
  humanOwner: string,
  loans: Loan[],
  repaymentsCount: number,
  totalInterestPaid = 0,
  asOfTimestamp = Date.now(),
  /** The tier table to read against - Sui's drops the fee requirement. */
  tiers: CreditTier[] = CREDIT_TIERS
): ReputationSummary {
  const humanLoans = loans.filter(
    (l) => l.humanOwner.toLowerCase() === humanOwner.toLowerCase()
  );

  const totalBorrowed = humanLoans.reduce((sum, l) => sum + (l.amount || 0), 0);
  const totalRepaid = humanLoans.reduce((sum, l) => sum + (l.totalRepaid || 0), 0);

  // Compute active loan history duration (total days loans have been held and serviced)
  let totalActiveMs = 0;
  for (const l of humanLoans) {
    const start = l.borrowedAt || asOfTimestamp;
    const end = l.status === "SETTLED" ? (l.settledAt || start) : asOfTimestamp;
    totalActiveMs += Math.max(0, end - start);
  }
  const totalActiveDurationDays = Math.round((totalActiveMs / (24 * 60 * 60 * 1000)) * 10) / 10;

  // Evaluate Tier Eligibility
  let currentTier = tiers[0];
  for (let i = tiers.length - 1; i >= 0; i--) {
    const tier = tiers[i];
    if (
      totalInterestPaid >= tier.requiredInterestPaid &&
      totalActiveDurationDays >= tier.requiredActiveDurationDays &&
      repaymentsCount >= tier.requiredRepaymentsCount
    ) {
      currentTier = tier;
      break;
    }
  }

  const nextTierIndex = tiers.findIndex(
    (t) => t.tierNumber === currentTier.tierNumber + 1
  );
  const nextTier = nextTierIndex !== -1 ? tiers[nextTierIndex] : null;

  // Next Tier Progress Metrics
  let interestProgressPct = 100;
  let durationProgressPct = 100;
  let repaymentProgressPct = 100;
  let overallProgressPct = 100;

  if (nextTier) {
    interestProgressPct = Math.min(
      100,
      nextTier.requiredInterestPaid > 0
        ? Math.round((totalInterestPaid / nextTier.requiredInterestPaid) * 100)
        : 100
    );
    durationProgressPct = Math.min(
      100,
      nextTier.requiredActiveDurationDays > 0
        ? Math.round((totalActiveDurationDays / nextTier.requiredActiveDurationDays) * 100)
        : 100
    );
    repaymentProgressPct = Math.min(
      100,
      nextTier.requiredRepaymentsCount > 0
        ? Math.round((repaymentsCount / nextTier.requiredRepaymentsCount) * 100)
        : 100
    );
    overallProgressPct = Math.round(
      (interestProgressPct * 0.4) + (durationProgressPct * 0.3) + (repaymentProgressPct * 0.3)
    );
  }

  // FIFO Maturity: Find the OLDEST unpaid loan
  const activeLoans = humanLoans
    .filter((l) => (l.outstandingAmount || 0) > 0.0001)
    .sort((a, b) => (a.borrowedAt || 0) - (b.borrowedAt || 0));

  let oldestActiveLoan = null;
  if (activeLoans.length > 0) {
    const oldest = activeLoans[0];
    const accrual = calculateLoanAccrual(oldest, asOfTimestamp);
    oldestActiveLoan = {
      loanId: oldest.loanId,
      agentAddress: oldest.agentAddress,
      dueTimestamp: accrual.dueTimestamp,
      hoursRemaining: accrual.hoursRemaining,
      isOverdue: accrual.isOverdue,
      isDueSoon: accrual.isDueSoon,
      totalDue: accrual.totalDue,
    };
  }

  // Base score (0–100)
  // Starts at 50 for verified human, boosted by on-time repayments and interest, penalized by overdue
  let score = 50 + Math.min(30, repaymentsCount * 3) + Math.min(20, totalInterestPaid * 10);
  if (oldestActiveLoan?.isOverdue) {
    score = Math.max(10, score - 40);
  } else if (oldestActiveLoan?.isDueSoon) {
    score = Math.max(30, score - 10);
  }
  const reputationScore = Math.min(100, Math.max(0, Math.round(score)));

  return {
    humanOwner,
    currentTier,
    nextTier,
    reputationScore,
    totalBorrowed,
    totalRepaid,
    totalInterestPaid,
    totalActiveDurationDays,
    repaymentsCount,
    oldestActiveLoan,
    tierProgress: {
      interestProgressPct,
      durationProgressPct,
      repaymentProgressPct,
      overallProgressPct,
    },
  };
}
